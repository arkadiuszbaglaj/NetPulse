"""Serwer HTTP usługi aktualizacji (tylko biblioteka standardowa).

Akcje (jedyny parametr z żądania to nazwa kopii, sprawdzana wyrażeniem regularnym – patrz backups.py):
  GET  /status   zainstalowana wersja, wynik ostatniego sprawdzenia, stan i log zadania
  POST /check    pobiera informacje ze źródła i zwraca, co jest do zainstalowania
  POST /update   uruchamia aktualizację w osobnym kontenerze (409, gdy już trwa)
  GET  /backups  lista kopii bazy i stan przywracania;  POST /backups  nowa kopia
  GET  /backups/<nazwa>/file  pobranie;  DELETE /backups/<nazwa>;  POST /backups/<nazwa>/restore
  POST /backups/upload  wgranie kopii (surowy plik .sql.gz w treści, wymagany Content-Length)
Wszystko poza /health wymaga nagłówka `Authorization: Bearer <NETPULSE_UPDATER_TOKEN>`.
Bez skonfigurowanego tokenu usługa odrzuca każde żądanie (aktualizacja z panelu wyłączona).
"""

from __future__ import annotations

import hmac
import json
import os
import subprocess
import threading
import time
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from . import git_ops, state
from .backups import BackupError, Backups
from .config import Settings

SOCKET = "/var/run/docker.sock"
# „Trwa”, a kontenera zadania nie ma → zadanie zginęło (po tej zwłoce, żeby nie trafić na start)
STALE_AFTER_S = 20


def job_running(s: Settings) -> bool:
    try:
        r = subprocess.run(
            ["docker", "inspect", "-f", "{{.State.Running}}", s.job_name], capture_output=True, text=True, timeout=15
        )
    except (OSError, subprocess.TimeoutExpired):
        return False  # bez Dockera zadanie i tak nie może działać
    return r.returncode == 0 and r.stdout.strip() == "true"


def launch_job(s: Settings) -> None:
    """Uruchamia zadanie w osobnym, odłączonym kontenerze z obrazu tej usługi.

    Dzięki temu wymiana samej usługi aktualizacji (docker compose up) nie przerywa zadania."""
    image = os.environ.get("NETPULSE_UPDATER_IMAGE", "")
    if not image:
        # Nazwa obrazu (netpulse-updater:local), a nie jego skrót: po przebudowie albo sprzątaniu stary skrót
        # może już nie istnieć („No such image: sha256:…”), a nazwa zawsze wskazuje aktualny obraz
        for field in ("{{.Config.Image}}", "{{.Image}}"):
            r = subprocess.run(
                ["docker", "inspect", "-f", field, os.environ.get("HOSTNAME", "")],
                capture_output=True,
                text=True,
                timeout=15,
            )
            image = r.stdout.strip()
            if image and subprocess.run(["docker", "image", "inspect", image], capture_output=True, timeout=15).returncode == 0:
                break
            image = ""
    if not image:
        raise RuntimeError("Nie udało się ustalić obrazu usługi aktualizacji.")
    d = str(s.install_dir)
    cmd = [
        "docker", "run", "-d", "--rm", "--name", s.job_name,
        "-v", f"{SOCKET}:{SOCKET}",
        "-v", f"{d}:{d}",
        "-e", f"NETPULSE_DIR={d}",
    ]  # fmt: skip
    for name in ("NETPULSE_UPDATE_REPO", "NETPULSE_UPDATE_BRANCH", "NETPULSE_MIN_FREE_MB", "NETPULSE_KEEP_BUILD_CACHE_HOURS", "TZ"):
        if os.environ.get(name):
            cmd += ["-e", f"{name}={os.environ[name]}"]
    cmd += ["--entrypoint", "python3", image, "-m", "netpulse_updater.job"]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        raise RuntimeError((r.stderr or r.stdout).strip()[-300:] or "docker run zakończył się błędem")


class UpdaterApp:
    """Logika serwera bez warstwy HTTP – łatwa do przetestowania."""

    def __init__(
        self,
        settings: Settings,
        launcher: Callable[[Settings], None] = launch_job,
        is_running: Callable[[Settings], bool] = job_running,
        checker: Callable[[Settings], dict[str, Any]] = git_ops.check,
        backups: Backups | None = None,
    ) -> None:
        self.s = settings
        self.launcher = launcher
        self.is_running = is_running
        self.checker = checker
        self.backups = backups or Backups(settings)
        self.max_upload_bytes = int(os.environ.get("NETPULSE_MAX_UPLOAD_MB", "4096")) * 1024 * 1024
        self._lock = threading.Lock()

    # --- widok zadania ------------------------------------------------------------

    def job_view(self) -> dict[str, Any]:
        status = state.read_status(self.s)
        if status["state"] == "running" and not self.is_running(self.s):
            started = status.get("started_at")
            age = (time.time() - _parse_ts(started)) if started else STALE_AFTER_S + 1
            if age > STALE_AFTER_S:
                status["state"] = "failed"
                status["error"] = status.get("error") or "Aktualizacja została przerwana."
                status["finished_at"] = status.get("finished_at") or state.now_iso()
                state.write_status(self.s, status)
        return {**status, "log": state.log_tail(self.s)}

    def problem(self) -> str | None:
        """Czytelny opis, gdy katalog instalacji (NETPULSE_DIR) nie wskazuje instalacji NetPulse."""
        if not (self.s.install_dir / "deploy" / "docker-compose.yml").is_file() or not (self.s.install_dir / ".git").exists():
            return (
                f"Katalog instalacji {self.s.install_dir} nie zawiera NetPulse. "
                "Ustaw w deploy/.env zmienną NETPULSE_DIR na katalog, w którym zainstalowano NetPulse, i uruchom: netpulse restart"
            )
        return None

    def status(self) -> dict[str, Any]:
        return {
            "current": git_ops.current(self.s),
            "info": state.read_check(self.s),
            "job": self.job_view(),
            "problem": self.problem(),
        }

    # --- akcje --------------------------------------------------------------------

    def check(self) -> tuple[int, dict[str, Any]]:
        with self._lock:
            try:
                info = self.checker(self.s)
            except git_ops.UpdateError as exc:
                return 502, {"error": str(exc)}
            state.write_check(self.s, info)
            return 200, self.status()

    def update(self) -> tuple[int, dict[str, Any]]:
        with self._lock:
            if problem := self.problem():
                return 409, {"error": problem}
            if self.is_running(self.s):
                return 409, {"error": "Aktualizacja już trwa."}
            if self.backups.busy:
                return 409, {"error": "Trwa przywracanie kopii bazy – aktualizację uruchom po jego zakończeniu."}
            cur = git_ops.current(self.s)
            status = state.new_status(cur["version"], cur["commit"])
            state.reset_log(self.s)
            state.write_status(self.s, status)
            try:
                self.launcher(self.s)
            except Exception as exc:
                status.update(state="failed", error=f"Nie udało się uruchomić aktualizacji: {exc}", finished_at=state.now_iso())
                state.write_status(self.s, status)
                return 500, {"error": status["error"]}
            return 202, self.status()

    # --- kopie bazy ----------------------------------------------------------------

    def backups_view(self) -> dict[str, Any]:
        from .backups import list_backups

        return {"backups": list_backups(self.s), "restore": self.backups.restore_status()}

    def backup_action(self, method: str, parts: list[str]) -> tuple[int, dict[str, Any]]:
        try:
            if parts == [] and method == "GET":
                return 200, self.backups_view()
            if parts == [] and method == "POST":
                if self.backups.busy:
                    return 409, {"error": "Trwa przywracanie kopii bazy."}
                return 201, {"backup": self.backups.create("manual"), **self.backups_view()}
            if len(parts) == 1 and method == "DELETE":
                self.backups.delete(parts[0])
                return 200, self.backups_view()
            if len(parts) == 2 and parts[1] == "restore" and method == "POST":
                if self.is_running(self.s):
                    return 409, {"error": "Trwa aktualizacja – przywracanie uruchom po jej zakończeniu."}
                self.backups.start_restore(parts[0])
                return 202, self.backups_view()
        except BackupError as exc:
            code = 404 if "Nie ma takiej" in str(exc) else 409 if "trwa" in str(exc) else 400
            return code, {"error": str(exc)}
        return 404, {"error": "Nie ma takiej akcji."}

    # --- routing ------------------------------------------------------------------

    def authorized(self, authorization: str | None) -> tuple[int, dict[str, Any]] | None:
        """None, gdy żądanie ma poprawny token; inaczej odpowiedź z błędem."""
        if not self.s.token:
            return 503, {"error": "Aktualizacje z panelu są wyłączone (NETPULSE_UPDATER=off)."}
        expected = f"Bearer {self.s.token}"
        if not hmac.compare_digest((authorization or "").encode(), expected.encode()):
            return 401, {"error": "Brak uprawnień."}
        return None

    def handle(self, method: str, path: str, authorization: str | None) -> tuple[int, dict[str, Any]]:
        path = path.split("?", 1)[0].rstrip("/") or "/"
        if method == "GET" and path == "/health":
            return 200, {"status": "ok"}
        if denied := self.authorized(authorization):
            return denied
        if path == "/backups" or path.startswith("/backups/"):
            return self.backup_action(method, [p for p in path.split("/")[2:] if p])
        if (method, path) == ("GET", "/status"):
            return 200, self.status()
        if (method, path) == ("POST", "/check"):
            return self.check()
        if (method, path) == ("POST", "/update"):
            return self.update()
        return 404, {"error": "Nie ma takiej akcji."}


def _parse_ts(iso: str) -> float:
    from datetime import datetime

    try:
        return datetime.fromisoformat(iso).timestamp()
    except ValueError:
        return 0.0


def make_handler(app: UpdaterApp) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "NetPulseUpdater"

        def _reply(self, method: str) -> None:
            # Treść żądania jest ignorowana (akcje nie przyjmują parametrów), ale trzeba ją przeczytać
            length = min(int(self.headers.get("Content-Length") or 0), 65536)
            if length:
                self.rfile.read(length)
            code, payload = app.handle(method, self.path, self.headers.get("Authorization"))
            body = json.dumps(payload, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _file(self) -> bool:
            """GET /backups/<nazwa>/file – plik kopii strumieniem (nie JSON)."""
            parts = [p for p in self.path.split("?", 1)[0].split("/") if p]
            if len(parts) != 3 or parts[0] != "backups" or parts[2] != "file":
                return False
            denied = app.authorized(self.headers.get("Authorization"))
            try:
                from .backups import path_of

                path = None if denied else path_of(app.s, parts[1])
            except BackupError as exc:
                denied = (404, {"error": str(exc)})
            if denied or path is None:
                code, payload = denied or (404, {"error": "Nie ma takiej kopii."})
                body = json.dumps(payload, ensure_ascii=False).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return True
            self.send_response(200)
            self.send_header("Content-Type", "application/gzip")
            self.send_header("Content-Length", str(path.stat().st_size))
            self.end_headers()
            with path.open("rb") as f:
                while chunk := f.read(1024 * 256):
                    self.wfile.write(chunk)
            return True

        def do_GET(self) -> None:  # noqa: N802
            if not self._file():
                self._reply("GET")

        def _send_json(self, code: int, payload: dict[str, Any]) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _upload(self) -> bool:
            """POST /backups/upload – treść żądania to plik kopii, zapisywany strumieniem."""
            if self.path.split("?", 1)[0].rstrip("/") != "/backups/upload":
                return False
            denied = app.authorized(self.headers.get("Authorization"))
            length = int(self.headers.get("Content-Length") or 0)
            if denied:
                self.close_connection = True  # treści nie czytamy
                self._send_json(*denied)
                return True
            if length <= 0 or length > app.max_upload_bytes:
                self.close_connection = True
                limit = app.max_upload_bytes // (1024 * 1024)
                self._send_json(413 if length else 411, {"error": f"Plik musi mieć rozmiar (Content-Length) i najwyżej {limit} MB."})
                return True
            try:
                backup = app.backups.upload(self.rfile, length)
            except BackupError as exc:
                self.close_connection = True
                self._send_json(409 if "trwa" in str(exc).lower() else 400, {"error": str(exc)})
                return True
            self._send_json(201, {"backup": backup, **app.backups_view()})
            return True

        def do_POST(self) -> None:  # noqa: N802
            if not self._upload():
                self._reply("POST")

        def do_DELETE(self) -> None:  # noqa: N802
            self._reply("DELETE")

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 – nie logujemy nagłówków
            pass

    return Handler


def serve(settings: Settings) -> None:
    from .apitoken import ensure_token

    settings = ensure_token(settings)
    app = UpdaterApp(settings)
    server = ThreadingHTTPServer(("0.0.0.0", settings.port), make_handler(app))
    state_msg = "włączona" if settings.token else "WYŁĄCZONA (NETPULSE_UPDATER=off)"
    print(f"Usługa aktualizacji NetPulse {state_msg}, nasłuchuje na :{settings.port}", flush=True)
    server.serve_forever()
