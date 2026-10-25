"""Kopie zapasowe bazy: tworzenie na żądanie, lista, pobieranie, usuwanie i przywracanie.

Kopia to `pg_dump` w formacie tekstowym, spakowany gzipem, w katalogu `backups` instalacji. Nazwa mówi,
skąd kopia pochodzi (to jedyne, co z żądania trafia do poleceń – sprawdzane wyrażeniem regularnym):
  netpulse-20261025-101500.sql.gz           przed aktualizacją (zadanie aktualizacji, zostają 3)
  netpulse-manual-20261025-101500.sql.gz    z panelu albo `netpulse backup` (zostaje 10)
  netpulse-prerestore-20261025-101500.sql.gz  automatycznie przed przywróceniem (zostają 3)

Przywracanie: kopia bezpieczeństwa → zatrzymanie API i kolektora → nowa, pusta baza → wczytanie kopii
(procedura TimescaleDB pre/post restore) → start usług (kolektor migruje schemat starszej kopii) → test API.
Gdy wczytanie się nie uda, wracamy do kopii bezpieczeństwa. Stan zadania jest w `.update/restore.json`.
"""

from __future__ import annotations

import gzip
import json
import re
import shutil
import subprocess
import threading
import time
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from typing import Any

from .config import Settings

NAME_RE = re.compile(r"^netpulse-(?:(manual|prerestore)-)?(\d{8}-\d{6})\.sql\.gz$")
KEEP = {"update": 3, "manual": 10, "prerestore": 3}
HEALTH_PY = "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=3)"
DUMP_TIMEOUT_S = 1800


class BackupError(Exception):
    """Niepowodzenie z komunikatem dla użytkownika."""


def compose(s: Settings) -> list[str]:
    d = s.install_dir
    return ["docker", "compose", "-f", str(d / "deploy" / "docker-compose.yml"), "--env-file", str(d / "deploy" / ".env")]


def kind_of(name: str) -> str | None:
    m = NAME_RE.match(name)
    return None if m is None else (m.group(1) or "update")


def path_of(s: Settings, name: str) -> Path:
    """Ścieżka kopii po sprawdzeniu nazwy; nic spoza katalogu kopii."""
    if kind_of(name) is None:
        raise BackupError("Nieprawidłowa nazwa kopii.")
    path = s.backups_dir / name
    if not path.is_file():
        raise BackupError("Nie ma takiej kopii.")
    return path


def list_backups(s: Settings) -> list[dict[str, Any]]:
    out = []
    for p in s.backups_dir.glob("netpulse-*.sql.gz") if s.backups_dir.is_dir() else []:
        m = NAME_RE.match(p.name)
        if not m:
            continue
        created = datetime.strptime(m.group(2), "%Y%m%d-%H%M%S").astimezone().isoformat(timespec="seconds")
        out.append({"name": p.name, "kind": m.group(1) or "update", "size_bytes": p.stat().st_size, "created_at": created})
    return sorted(out, key=lambda b: b["created_at"], reverse=True)


def prune(s: Settings, kind: str) -> None:
    same = sorted(p for p in s.backups_dir.glob("netpulse-*.sql.gz") if kind_of(p.name) == kind)
    for old in same[: -KEEP[kind]]:
        old.unlink(missing_ok=True)


# --- polecenia (podmieniane w testach) -----------------------------------------------------


def run_dump(s: Settings, target: Path) -> int:
    """pg_dump z kontenera bazy prosto do pliku .gz."""
    with subprocess.Popen(compose(s) + ["exec", "-T", "db", "pg_dump", "-U", "netpulse", "netpulse"], stdout=subprocess.PIPE) as proc:
        assert proc.stdout is not None
        with gzip.open(target, "wb") as out:
            shutil.copyfileobj(proc.stdout, out)
        return proc.wait(timeout=DUMP_TIMEOUT_S)


def run_psql(s: Settings, database: str, sql: str | None = None, source: Path | None = None) -> int:
    """psql w kontenerze bazy: polecenie SQL albo zawartość kopii (.gz) na wejściu."""
    cmd = compose(s) + ["exec", "-T", "db", "psql", "-U", "netpulse", "-d", database, "-q", "-v", "ON_ERROR_STOP=0"]
    if sql is not None:
        return subprocess.run(cmd + ["-c", sql], capture_output=True, timeout=300).returncode
    assert source is not None
    with subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) as proc:
        assert proc.stdin is not None
        with gzip.open(source, "rb") as f:
            shutil.copyfileobj(f, proc.stdin)
        proc.stdin.close()
        return proc.wait(timeout=DUMP_TIMEOUT_S)


def run_compose(s: Settings, *args: str) -> int:
    return subprocess.run(compose(s) + list(args), capture_output=True, timeout=600).returncode


def query_one(s: Settings, sql: str) -> str:
    r = subprocess.run(
        compose(s) + ["exec", "-T", "db", "psql", "-U", "netpulse", "-d", "netpulse", "-tAc", sql],
        capture_output=True, text=True, timeout=60,
    )  # fmt: skip
    return r.stdout.strip() if r.returncode == 0 else ""


def api_healthy(s: Settings) -> bool:
    return run_compose(s, "exec", "-T", "api", "python", "-c", HEALTH_PY) == 0


class Backups:
    """Operacje na kopiach. Funkcje wykonujące polecenia można podmienić (testy bez Dockera)."""

    def __init__(
        self,
        settings: Settings,
        dump: Callable[[Settings, Path], int] = run_dump,
        psql: Callable[..., int] = run_psql,
        compose_cmd: Callable[..., int] = run_compose,
        query: Callable[[Settings, str], str] = query_one,
        healthy: Callable[[Settings], bool] = api_healthy,
        sleep: Callable[[float], None] = time.sleep,
        health_timeout_s: int = 150,
    ) -> None:
        self.s = settings
        self.dump, self.psql, self.compose_cmd, self.query, self.healthy, self.sleep = dump, psql, compose_cmd, query, healthy, sleep
        self.health_timeout_s = health_timeout_s
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None

    # --- stan przywracania ------------------------------------------------------------------

    @property
    def _status_file(self) -> Path:
        return self.s.state_dir / "restore.json"

    def restore_status(self) -> dict[str, Any]:
        try:
            status = json.loads(self._status_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {"state": "idle"}
        if status.get("state") == "running" and not (self._thread and self._thread.is_alive()):
            # Usługa została zrestartowana w trakcie – zadanie nie żyje
            status.update(state="failed", error=status.get("error") or "Przywracanie zostało przerwane.")
            self._write(status)
        return status

    def _write(self, status: dict[str, Any]) -> None:
        self.s.state_dir.mkdir(parents=True, exist_ok=True)
        tmp = self._status_file.with_suffix(".tmp")
        tmp.write_text(json.dumps(status, ensure_ascii=False), encoding="utf-8")
        tmp.replace(self._status_file)

    @property
    def busy(self) -> bool:
        return bool(self._thread and self._thread.is_alive())

    # --- operacje ---------------------------------------------------------------------------

    def create(self, kind: str = "manual") -> dict[str, Any]:
        d = self.s.backups_dir
        d.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        target = d / f"netpulse-{kind}-{stamp}.sql.gz"
        if target.exists():  # dwie kopie w tej samej sekundzie
            time.sleep(1)
            return self.create(kind)
        try:
            rc = self.dump(self.s, target)
        except (OSError, subprocess.SubprocessError) as exc:
            rc = -1
            err = str(exc)
        else:
            err = ""
        if rc != 0 or not target.exists() or target.stat().st_size < 20:
            target.unlink(missing_ok=True)
            raise BackupError(f"Nie udało się wykonać kopii bazy danych. {err}".strip())
        target.chmod(0o600)
        prune(self.s, kind)
        return next(b for b in list_backups(self.s) if b["name"] == target.name)

    def delete(self, name: str) -> None:
        path_of(self.s, name).unlink()

    def start_restore(self, name: str) -> dict[str, Any]:
        with self._lock:
            if self.busy:
                raise BackupError("Przywracanie już trwa.")
            path_of(self.s, name)
            status = {"state": "running", "backup": name, "step": "safety", "started_at": _now(), "error": None, "safety": None}
            self._write(status)
            self._thread = threading.Thread(target=self._restore, args=(name, status), daemon=True)
            self._thread.start()
            return status

    def _restore(self, name: str, status: dict[str, Any]) -> None:
        def step(name_: str) -> None:
            status["step"] = name_
            self._write(status)

        stopped = False
        try:
            source = path_of(self.s, name)
            step("safety")
            status["safety"] = self.create("prerestore")["name"]
            step("stop")
            if self.compose_cmd(self.s, "stop", "api", "collector") != 0:
                raise BackupError("Nie udało się zatrzymać usług NetPulse. Baza nie została zmieniona.")
            stopped = True
            step("load")
            if not self._load(source):
                step("rollback")
                safety_ok = self._load(path_of(self.s, status["safety"]))
                raise BackupError(
                    "Wczytanie kopii nie powiodło się. "
                    + ("Przywrócono stan sprzed próby." if safety_ok else f"Przywrócenie stanu sprzed próby też się nie udało – kopia: {status['safety']}.")
                )
            step("start")
            self._start_and_wait()
            status.update(state="ok", step="done", finished_at=_now())
            self._write(status)
        except BackupError as exc:
            if stopped:
                try:
                    self._start_and_wait()
                except BackupError:
                    pass
            status.update(state="failed", error=str(exc), finished_at=_now())
            self._write(status)
        except Exception as exc:  # nigdy nie zostawiamy stanu „trwa”
            if stopped:
                self.compose_cmd(self.s, "start", "api", "collector")
            status.update(state="failed", error=f"Nieoczekiwany błąd: {exc}", finished_at=_now())
            self._write(status)

    def _load(self, source: Path) -> bool:
        """Nowa, pusta baza i wczytanie kopii. True, gdy w bazie są tabele NetPulse."""
        self.psql(self.s, "postgres", sql="DROP DATABASE IF EXISTS netpulse WITH (FORCE)")
        if self.psql(self.s, "postgres", sql="CREATE DATABASE netpulse OWNER netpulse") != 0:
            return False
        self.psql(self.s, "netpulse", sql="CREATE EXTENSION IF NOT EXISTS timescaledb; SELECT timescaledb_pre_restore();")
        # Kod wyjścia psql nie przesądza o wyniku (np. „rozszerzenie już istnieje”) – sprawdzamy dane
        self.psql(self.s, "netpulse", source=source)
        self.psql(self.s, "netpulse", sql="SELECT timescaledb_post_restore();")
        return self.query(self.s, "SELECT count(*) FROM devices") != ""

    def _start_and_wait(self) -> None:
        if self.compose_cmd(self.s, "start", "collector", "api") != 0:
            raise BackupError("Kopia została wczytana, ale usługi nie wystartowały. Sprawdź: netpulse status")
        deadline = time.monotonic() + self.health_timeout_s
        while time.monotonic() < deadline:
            if self.healthy(self.s):
                return
            self.sleep(3)
        raise BackupError("Kopia została wczytana, ale API nie odpowiada. Sprawdź: netpulse logs")


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")
