"""Zadanie aktualizacji. Działa w osobnym, jednorazowym kontenerze, żeby przetrwać wymianę
samej usługi aktualizacji w trakcie (`python -m netpulse_updater.job`).

Fazy: prepare (miejsce na dysku) → backup (kopia bazy) → fetch (pobranie kodu) → build →
start → verify (czy API odpowiada). Gdy po zmianie kodu coś się nie uda, wracamy do
poprzedniej wersji (rollback), a stan i log zostają w plikach do wyświetlenia w panelu.
"""

from __future__ import annotations

import gzip
import shutil
import subprocess
import sys
import time
from collections.abc import Callable
from datetime import datetime
from pathlib import Path

from . import git_ops, state
from .config import Settings
from .envfile import topup_env

HEALTH_PY = "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=3)"

# runner(polecenie, katalog, funkcja_logu, zapis_gzip) → kod wyjścia
Runner = Callable[[list[str], Path, Callable[[str], None], Path | None], int]


class StepError(Exception):
    """Niepowodzenie fazy z komunikatem dla użytkownika."""


def default_runner(cmd: list[str], cwd: Path, log: Callable[[str], None], gzip_to: Path | None = None) -> int:
    """Uruchamia polecenie i przekazuje jego wyjście do logu (albo, dla kopii bazy, do pliku .gz)."""
    if gzip_to is not None:
        with subprocess.Popen(cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE) as proc:
            assert proc.stdout is not None and proc.stderr is not None
            with gzip.open(gzip_to, "wb") as out:
                shutil.copyfileobj(proc.stdout, out)
            for line in proc.stderr.read().decode("utf-8", "replace").splitlines():
                log(line)
            return proc.wait()
    with subprocess.Popen(
        cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace"
    ) as proc:
        assert proc.stdout is not None
        for line in proc.stdout:
            log(line)
        return proc.wait()


class Job:
    def __init__(
        self,
        settings: Settings,
        runner: Runner = default_runner,
        sleep: Callable[[float], None] = time.sleep,
        disk_free_mb: Callable[[], int] | None = None,
    ) -> None:
        self.s = settings
        self.runner = runner
        self.sleep = sleep
        self.disk_free_mb = disk_free_mb or (lambda: shutil.disk_usage(settings.install_dir).free // (1024 * 1024))
        self.status: dict = state.idle_status()
        self.merged = False  # kod został zmieniony (do wycofania)
        self.touched = False  # usługi zostały przebudowane/uruchomione (do wycofania)

    # --- pomocnicze ---------------------------------------------------------------

    def log(self, line: str) -> None:
        state.append_log(self.s, line)

    def _save(self) -> None:
        state.write_status(self.s, self.status)

    def _phase(self, phase: str, status: str) -> None:
        self.status["phase"] = phase
        for p in self.status["phases"]:
            if p["id"] == phase:
                p["status"] = status
        self._save()

    def sh(self, cmd: list[str], gzip_to: Path | None = None) -> int:
        return self.runner(cmd, self.s.install_dir, self.log, gzip_to)

    def must(self, cmd: list[str], error: str) -> None:
        if self.sh(cmd) != 0:
            raise StepError(error)

    @property
    def compose(self) -> list[str]:
        d = self.s.install_dir
        return ["docker", "compose", "-f", str(d / "deploy" / "docker-compose.yml"), "--env-file", str(d / "deploy" / ".env")]

    def _step(self, phase: str, fn: Callable[[], None]) -> None:
        self.log(f"== {phase}")
        self._phase(phase, "running")
        fn()
        self._phase(phase, "done")

    # --- fazy ---------------------------------------------------------------------

    def prepare(self) -> None:
        free = self.disk_free_mb()
        self.log(f"Wolne miejsce: {free} MB (wymagane co najmniej {self.s.min_free_mb} MB)")
        if free < self.s.min_free_mb:
            self.log("Mało miejsca – czyszczę nieużywane dane Dockera (baza zostaje)")
            self.sh(["docker", "builder", "prune", "-af"])
            self.sh(["docker", "image", "prune", "-f"])
            free = self.disk_free_mb()
            self.log(f"Wolne miejsce po sprzątaniu: {free} MB")
        if free < self.s.min_free_mb:
            raise StepError(
                f"Za mało miejsca na dysku: wolne {free} MB, a aktualizacja wymaga co najmniej {self.s.min_free_mb} MB. "
                "Zwolnij miejsce (polecenie: netpulse cleanup) i spróbuj ponownie. Nic nie zostało zmienione."
            )

    def backup(self) -> None:
        d = self.s.backups_dir
        d.mkdir(parents=True, exist_ok=True)
        target = d / f"netpulse-{datetime.now().strftime('%Y%m%d-%H%M%S')}.sql.gz"
        rc = self.sh(self.compose + ["exec", "-T", "db", "pg_dump", "-U", "netpulse", "netpulse"], gzip_to=target)
        if rc != 0 or not target.exists() or target.stat().st_size < 20:
            target.unlink(missing_ok=True)
            raise StepError("Nie udało się wykonać kopii bazy danych, więc aktualizacji nie rozpoczęto. Nic nie zostało zmienione.")
        target.chmod(0o600)
        self.log(f"Kopia bazy: {target.name} ({target.stat().st_size // 1024} KB)")
        for old in sorted(d.glob("netpulse-*.sql.gz"))[: -self.s.backups_keep]:
            old.unlink(missing_ok=True)

    def fetch(self) -> bool:
        """Pobiera i scala kod. False = nie było nic do zainstalowania."""
        branch = git_ops.branch_name(self.s)
        if self.s.repo_url:
            self.sh(["git", "remote", "set-url", "origin", self.s.repo_url])
        self.must(["git", "fetch", "--quiet", "origin", branch], "Nie udało się pobrać aktualizacji ze źródła.")
        before = self.status["from_commit"]
        self.must(
            ["git", "merge", "--ff-only", "--quiet", f"origin/{branch}"],
            "Nie można prosto zaktualizować kodu (instalacja ma lokalne zmiany). Zaktualizuj ręcznie: netpulse update",
        )
        after = git_ops.current(self.s)
        self.status["to_version"] = after["version"]
        self.status["to_commit"] = after["commit"]
        if after["commit"] == before:
            return False
        self.merged = True
        added = topup_env(self.s.install_dir)
        if added:
            self.log("Dopisano do .env nowe zmienne: " + ", ".join(added))
        return True

    def build(self) -> None:
        self.must(self.compose + ["build"], "Budowanie nowej wersji nie powiodło się.")

    def start(self) -> None:
        self.touched = True
        self.must(self.compose + ["up", "-d", "--remove-orphans"], "Uruchomienie nowej wersji nie powiodło się.")

    def healthy(self) -> bool:
        deadline = time.monotonic() + self.s.health_timeout_s
        while True:
            if self.sh(self.compose + ["exec", "-T", "api", "python", "-c", HEALTH_PY]) == 0:
                return True
            if time.monotonic() >= deadline:
                return False
            self.sleep(3)

    def verify(self) -> None:
        if not self.healthy():
            raise StepError(f"Nowa wersja nie odpowiada po {self.s.health_timeout_s} s.")

    # --- całość -------------------------------------------------------------------

    def run(self) -> str:
        """Wykonuje aktualizację. Zwraca końcowy stan: ok | failed | rolled_back."""
        state.reset_log(self.s)
        old = git_ops.current(self.s)
        self.status = state.new_status(old["version"], old["commit"])
        self._save()
        self.log(f"Aktualizacja z wersji {old['version']} ({old['commit']})")
        try:
            self._step("prepare", self.prepare)
            self._step("backup", self.backup)
            changed = []

            def do_fetch() -> None:
                changed.append(self.fetch())

            self._step("fetch", do_fetch)
            if not changed[0]:
                self.log("Nic do zainstalowania – masz już najnowszą wersję.")
                for p in self.status["phases"]:
                    if p["status"] == "pending":
                        p["status"] = "skipped"
                return self._finish("ok", note="Masz już najnowszą wersję.")
            self._step("build", self.build)
            self._step("start", self.start)
            self._step("verify", self.verify)
        except StepError as exc:
            return self._fail(str(exc), old["commit"])
        except Exception as exc:  # nieoczekiwany błąd nie może zostawić stanu „trwa”
            self.log(f"Nieoczekiwany błąd: {type(exc).__name__}: {exc}")
            return self._fail(f"Nieoczekiwany błąd: {exc}", old["commit"])

        # Cache budowania: świeży zostaje (następna aktualizacja będzie szybka), stary znika
        self.sh(["docker", "builder", "prune", "-f", "--filter", f"until={self.s.keep_cache_hours}h"])
        self.sh(["docker", "image", "prune", "-f"])
        return self._finish("ok")

    def _fail(self, message: str, old_commit: str | None) -> str:
        phase = self.status.get("phase")
        if phase:
            self._phase(phase, "failed")
        self.status["error"] = message
        self.log(f"BŁĄD: {message}")
        if not self.merged or not old_commit:
            return self._finish("failed")

        self.log(f"Wracam do poprzedniej wersji ({old_commit})")
        self.sh(["git", "reset", "--hard", old_commit])
        if not self.touched:
            self.status["note"] = "Usługi działają dalej na poprzedniej wersji."
            return self._finish("failed")

        self.status["phases"].append({"id": "rollback", "status": "running"})
        self.status["phase"] = "rollback"
        self._save()
        restored = self.sh(self.compose + ["up", "-d", "--build", "--remove-orphans"]) == 0 and self.healthy()
        self.status["phases"][-1]["status"] = "done" if restored else "failed"
        if restored:
            self.status["note"] = "Przywrócono poprzednią wersję. Dane są nienaruszone."
            return self._finish("rolled_back")
        self.status["note"] = (
            "Nie udało się przywrócić poprzedniej wersji automatycznie. "
            "Kopia bazy jest w katalogu backups. Sprawdź: netpulse logs"
        )
        return self._finish("failed")

    def _finish(self, final: str, note: str | None = None) -> str:
        self.status["state"] = final
        self.status["finished_at"] = state.now_iso()
        if note:
            self.status["note"] = note
        if final == "ok":
            cur = git_ops.current(self.s)
            self.status["to_version"] = cur["version"]
            self.status["to_commit"] = cur["commit"]
            self.status["phase"] = None
        self._save()
        return final


def main() -> int:
    settings = Settings.from_env()
    return 0 if Job(settings).run() in ("ok",) else 1


if __name__ == "__main__":
    sys.exit(main())
