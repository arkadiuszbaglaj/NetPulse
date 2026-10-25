"""API aktualizacji z panelu rozmawiające z prawdziwym serwerem usługi updater (bez Dockera i bazy).

Logowanie podmieniamy zależnością, a usługę aktualizacji uruchamiamy lokalnie w wątku, z atrapą
uruchamiania zadania.
"""

from __future__ import annotations

import asyncio
import subprocess
import sys
import threading
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "updater"))

from netpulse_updater.config import Settings  # noqa: E402
from netpulse_updater.server import UpdaterApp, make_handler  # noqa: E402
from test_updater import Launcher, Repo  # noqa: E402

from netpulse import __version__  # noqa: E402
from netpulse.api import app, updates  # noqa: E402
from netpulse.api.security import require_user  # noqa: E402
from netpulse.config import settings as real_settings  # noqa: E402
from netpulse.db.models import User  # noqa: E402

pytestmark = pytest.mark.skipif(
    subprocess.run(["git", "--version"], capture_output=True).returncode != 0, reason="brak gita"
)

TOKEN = "tajny-token"


class Running:
    value = False

    def __call__(self, _settings) -> bool:
        return self.value


@pytest.fixture
def updater(tmp_path):
    """Działająca usługa aktualizacji na repozytorium testowym; zwraca (adres, repo, launcher, running)."""
    repo = Repo(tmp_path)
    launcher, running = Launcher(), Running()
    updater_app = UpdaterApp(
        Settings(install_dir=repo.install, token=TOKEN, health_timeout_s=0), launcher=launcher, is_running=running
    )
    server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(updater_app))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}", repo, launcher, running
    server.shutdown()


def configure(monkeypatch, url: str = "", token: str = TOKEN) -> None:
    monkeypatch.setattr(updates, "settings", replace(real_settings, updater_url=url, updater_token=token))


def as_user(is_admin: bool) -> None:
    app.dependency_overrides[require_user] = lambda: User(id=1, username="jan", password_hash="x", is_admin=is_admin)


@pytest.fixture(autouse=True)
def _clean_overrides():
    yield
    app.dependency_overrides.clear()


@pytest.fixture
def client():
    as_user(True)
    return TestClient(app)


def test_requires_login():
    app.dependency_overrides.clear()
    # bez bazy zależność logowania nie zdąży zapytać o sesję – brak ciasteczka daje 401 od razu
    with TestClient(app) as c:
        assert c.get("/api/updates").status_code == 401
        assert c.post("/api/updates/check").status_code == 401
        assert c.post("/api/updates/apply").status_code == 401


def test_not_configured_reports_command_line_fallback(client, monkeypatch):
    configure(monkeypatch, url="", token="")
    r = client.get("/api/updates").json()
    assert r["installed_version"] == __version__
    assert r["updater"]["configured"] is False and "netpulse update" in r["updater"]["message"]
    assert r["info"] is None and r["job"] is None
    assert client.post("/api/updates/check").status_code == 503
    assert client.post("/api/updates/apply").status_code == 503


def test_status_includes_current_version_and_idle_job(client, monkeypatch, updater):
    url, repo, _, _ = updater
    configure(monkeypatch, url)
    r = client.get("/api/updates").json()
    assert r["updater"] == {"configured": True, "reachable": True, "message": None}
    assert r["current"]["version"] == "0.1.0" and r["current"]["commit"] == repo.head()
    assert r["job"]["state"] == "idle" and r["job"]["log"] == [] and r["info"] is None


def test_check_up_to_date(client, monkeypatch, updater):
    configure(monkeypatch, updater[0])
    info = client.post("/api/updates/check").json()["info"]
    assert info["update_available"] is False and info["behind"] == 0 and info["changes"] == []


def test_check_reports_new_version_and_changes(client, monkeypatch, updater):
    url, repo, _, _ = updater
    configure(monkeypatch, url)
    repo.commit("0.2.0", "Etap 6: nowa funkcja")
    info = client.post("/api/updates/check").json()["info"]
    assert info["update_available"] is True and info["behind"] == 1
    assert info["latest"]["version"] == "0.2.0" and info["current"]["version"] == "0.1.0"
    assert info["changes"][0]["subject"] == "Etap 6: nowa funkcja"
    # wynik sprawdzenia widać też później w statusie
    assert client.get("/api/updates").json()["info"]["latest"]["version"] == "0.2.0"


def test_check_error_from_source_is_502_with_message(client, monkeypatch, updater):
    url, repo, _, _ = updater
    configure(monkeypatch, url)
    subprocess.run(["git", "remote", "set-url", "origin", str(repo.remote.parent / "nie-ma.git")], cwd=repo.install, check=True)
    r = client.post("/api/updates/check")
    assert r.status_code == 502 and "źródłem aktualizacji" in r.json()["detail"]


def test_apply_starts_update_for_admin_only(client, monkeypatch, updater):
    url, _, launcher, _ = updater
    configure(monkeypatch, url)

    as_user(False)
    assert client.post("/api/updates/apply").status_code == 403
    assert client.post("/api/updates/check").status_code == 403
    assert launcher.calls == 0
    assert client.get("/api/updates").status_code == 200  # podgląd dla każdego zalogowanego

    as_user(True)
    r = client.post("/api/updates/apply")
    assert r.status_code == 202 and launcher.calls == 1
    assert r.json()["job"]["state"] == "running"


def test_apply_while_running_is_conflict(client, monkeypatch, updater):
    url, _, launcher, running = updater
    configure(monkeypatch, url)
    running.value = True
    r = client.post("/api/updates/apply")
    assert r.status_code == 409 and "już trwa" in r.json()["detail"] and launcher.calls == 0


def test_launch_failure_is_reported(client, monkeypatch, updater):
    url, _, launcher, _ = updater
    configure(monkeypatch, url)
    launcher.fail = True
    r = client.post("/api/updates/apply")
    assert r.status_code == 502 and "docker run nie działa" in r.json()["detail"]


def test_token_is_read_from_shared_file(client, monkeypatch, updater, tmp_path):
    """W instalacji token leży w pliku z wolumenu: API czyta go przy każdym żądaniu."""
    url = updater[0]
    token_file = tmp_path / "updater-token"
    monkeypatch.setattr(
        updates, "settings", replace(real_settings, updater_url=url, updater_token="", updater_token_file=str(token_file))
    )
    # usługa jeszcze nie wystartowała (brak pliku) → aktualizacja z panelu nie jest skonfigurowana
    assert client.get("/api/updates").json()["updater"]["configured"] is False
    token_file.write_text(TOKEN + "\n")  # usługa zapisała token (z końcowym znakiem nowej linii)
    status = client.get("/api/updates").json()
    assert status["updater"] == {"configured": True, "reachable": True, "message": None}


def test_wrong_install_dir_is_explained(client, monkeypatch, updater):
    url, repo, _, _ = updater
    configure(monkeypatch, url)
    (repo.install / "deploy" / "docker-compose.yml").unlink()
    status = client.get("/api/updates").json()
    assert status["updater"]["reachable"] is False and "NETPULSE_DIR" in status["updater"]["message"]
    r = client.post("/api/updates/apply")
    assert r.status_code == 409 and "nie zawiera NetPulse" in r.json()["detail"]


def test_wrong_token_gives_hint_to_restart(client, monkeypatch, updater):
    configure(monkeypatch, updater[0], token="inny-token")
    status = client.get("/api/updates").json()
    assert status["updater"]["configured"] is True and status["updater"]["reachable"] is False
    assert "netpulse restart" in status["updater"]["message"]
    assert "netpulse restart" in client.post("/api/updates/check").json()["detail"]


def test_unreachable_updater(client, monkeypatch):
    configure(monkeypatch, "http://127.0.0.1:9")  # nic tam nie nasłuchuje
    status = client.get("/api/updates").json()
    assert status["updater"]["reachable"] is False and "netpulse status" in status["updater"]["message"]
    assert status["installed_version"] == __version__  # wersja API jest znana mimo braku usługi
    r = client.post("/api/updates/apply")
    assert r.status_code == 502 and "nie odpowiada" in r.json()["detail"]


def test_token_never_reaches_the_browser(client, monkeypatch, updater):
    configure(monkeypatch, updater[0])
    for response in (client.get("/api/updates"), client.post("/api/updates/check")):
        assert TOKEN not in response.text and "127.0.0.1" not in response.text


# --- automatyczne sprawdzanie ------------------------------------------------------------------


def run_auto(monkeypatch, cfg: updates.UpdateSettings, now: datetime | None = None) -> bool:
    async def fake_settings():
        return cfg

    monkeypatch.setattr(updates, "load_settings", fake_settings)
    return asyncio.run(updates.auto_check_once(now))


def test_is_due():
    now = datetime(2026, 10, 25, 12, 0, tzinfo=UTC)
    assert updates._is_due(None, 24, now)
    assert updates._is_due("nie-data", 24, now)
    assert not updates._is_due((now - timedelta(hours=3)).isoformat(), 24, now)
    assert updates._is_due((now - timedelta(hours=25)).isoformat(), 24, now)
    assert updates._is_due((now - timedelta(hours=7)).isoformat().replace("+00:00", "Z"), 6, now)


def test_auto_check_runs_when_never_checked_and_then_waits(client, monkeypatch, updater):
    url, repo, _, _ = updater
    configure(monkeypatch, url)
    repo.commit("0.2.0", "Etap 6: nowa funkcja")
    cfg = updates.UpdateSettings(auto_check=True, interval_h=24)
    assert run_auto(monkeypatch, cfg) is True
    assert client.get("/api/updates").json()["info"]["update_available"] is True
    assert run_auto(monkeypatch, cfg) is False  # świeży wynik: za wcześnie na kolejne sprawdzenie
    assert run_auto(monkeypatch, cfg, datetime.now(UTC) + timedelta(hours=25)) is True


def test_auto_check_disabled_or_unconfigured_does_nothing(client, monkeypatch, updater):
    configure(monkeypatch, updater[0])
    assert run_auto(monkeypatch, updates.UpdateSettings(auto_check=False)) is False
    assert client.get("/api/updates").json()["info"] is None
    configure(monkeypatch, url="", token="")
    assert run_auto(monkeypatch, updates.UpdateSettings(auto_check=True)) is False


def test_auto_check_survives_unreachable_updater(monkeypatch):
    configure(monkeypatch, "http://127.0.0.1:9")
    assert run_auto(monkeypatch, updates.UpdateSettings(auto_check=True)) is False
