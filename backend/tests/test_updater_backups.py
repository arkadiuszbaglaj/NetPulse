"""Kopie zapasowe w usłudze aktualizacji: tworzenie, limity, nazwy, pobieranie, przywracanie i wycofanie
(atrapy Dockera i psql – bez demona Dockera)."""

from __future__ import annotations

import gzip
import json
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "updater"))

from netpulse_updater import backups as bk  # noqa: E402
from netpulse_updater.backups import BackupError, Backups, kind_of, list_backups, prune  # noqa: E402
from netpulse_updater.config import Settings  # noqa: E402
from netpulse_updater.server import UpdaterApp, make_handler  # noqa: E402

TOKEN = "t" * 32


class FakeDb:
    """Atrapa bazy: „zawartość” to tekst ostatnio wczytanej kopii; zapisuje kolejność poleceń."""

    def __init__(self, content: str = "stan-obecny", load_ok: bool = True) -> None:
        self.content = content
        self.load_ok = load_ok
        self.calls: list[str] = []

    def dump(self, s, target: Path) -> int:
        with gzip.open(target, "wt", encoding="utf-8") as f:
            f.write(f"-- dump\n{self.content}\n")
        self.calls.append("dump")
        return 0

    def psql(self, s, database, sql=None, source=None) -> int:
        if source is not None:
            text = gzip.open(source, "rt", encoding="utf-8").read()
            self.calls.append(f"load:{source.name}")
            if not self.load_ok and "prerestore" not in source.name:
                self.content = ""  # zepsuta kopia
            else:
                self.content = text.splitlines()[-1]
        elif sql.startswith("DROP DATABASE"):
            self.calls.append("drop")
            self.content = ""
        return 0

    def query(self, s, sql) -> str:
        return "1" if self.content else ""

    def compose(self, s, *args) -> int:
        self.calls.append(" ".join(args))
        return 0


@pytest.fixture
def settings(tmp_path):
    (tmp_path / "deploy").mkdir()
    (tmp_path / "deploy" / "docker-compose.yml").write_text("services: {}\n")
    (tmp_path / ".git").mkdir()
    return Settings(install_dir=tmp_path, token=TOKEN)


def make(settings, db: FakeDb, **kw) -> Backups:
    return Backups(settings, dump=db.dump, psql=db.psql, compose_cmd=db.compose, query=db.query, healthy=lambda s: True, sleep=lambda _: None, **kw)


def wait_done(b: Backups) -> dict:
    for _ in range(200):
        if not b.busy:
            break
        time.sleep(0.02)
    return b.restore_status()


def test_names_and_kinds():
    assert kind_of("netpulse-20261025-101500.sql.gz") == "update"
    assert kind_of("netpulse-manual-20261025-101500.sql.gz") == "manual"
    assert kind_of("netpulse-prerestore-20261025-101500.sql.gz") == "prerestore"
    for bad in ("../etc/passwd", "netpulse-manual-2026.sql.gz", "netpulse-x-20261025-101500.sql.gz", "netpulse-20261025-101500.sql.gz/../x"):
        assert kind_of(bad) is None


def test_create_list_and_limits_per_kind(settings):
    d = settings.backups_dir
    d.mkdir()
    for i in range(4):
        (d / f"netpulse-2026010{i}-000000.sql.gz").write_bytes(b"x" * 30)
    for i in range(12):
        (d / f"netpulse-manual-202601{10 + i}-000000.sql.gz").write_bytes(b"x" * 30)
    prune(settings, "update")
    prune(settings, "manual")
    kinds = [b["kind"] for b in list_backups(settings)]
    assert kinds.count("update") == 3 and kinds.count("manual") == 10
    created = make(settings, FakeDb()).create()
    assert created["kind"] == "manual" and created["size_bytes"] > 20
    assert list_backups(settings)[0]["name"] == created["name"]  # najnowsza na górze
    assert [b["kind"] for b in list_backups(settings)].count("manual") == 10


def test_failed_dump_leaves_no_file(settings):
    db = FakeDb()
    b = make(settings, db)
    b.dump = lambda s, target: 1
    with pytest.raises(BackupError):
        b.create()
    assert list_backups(settings) == []


def test_restore_happy_path(settings):
    db = FakeDb(content="stan-z-kopii")
    b = make(settings, db)
    name = b.create()["name"]
    db.content = "stan-obecny"
    b.start_restore(name)
    status = wait_done(b)
    assert status["state"] == "ok", status
    assert db.content == "stan-z-kopii"
    assert kind_of(status["safety"]) == "prerestore"
    # Kolejność: kopia bezpieczeństwa, zatrzymanie, nowa baza, wczytanie, start
    assert db.calls[1:] == ["dump", "stop api collector", "drop", f"load:{name}", "start collector api"]


def test_restore_failure_rolls_back_to_safety_copy(settings):
    db = FakeDb(content="dobra-kopia")
    b = make(settings, db)
    name = b.create()["name"]
    db.content, db.load_ok = "stan-obecny", False
    b.start_restore(name)
    status = wait_done(b)
    assert status["state"] == "failed"
    assert "Przywrócono stan sprzed próby" in status["error"]
    assert db.content == "stan-obecny"  # wrócił stan sprzed próby
    assert db.calls[-1] == "start collector api"  # usługi znowu działają


def test_restore_refuses_unknown_name_and_second_restore(settings):
    db = FakeDb()
    b = make(settings, db)
    with pytest.raises(BackupError):
        b.start_restore("netpulse-manual-20200101-000000.sql.gz")
    name = b.create()["name"]
    gate = threading.Event()
    b.healthy = lambda s: gate.wait(5)
    b.start_restore(name)
    with pytest.raises(BackupError, match="trwa"):
        b.start_restore(name)
    gate.set()
    assert wait_done(b)["state"] == "ok"


def test_interrupted_restore_is_reported(settings):
    b = make(settings, FakeDb())
    settings.state_dir.mkdir(parents=True)
    (settings.state_dir / "restore.json").write_text(json.dumps({"state": "running", "backup": "x"}))
    assert b.restore_status()["state"] == "failed"


def test_app_routes(settings):
    db = FakeDb()
    app = UpdaterApp(settings, launcher=lambda s: None, is_running=lambda s: False, backups=make(settings, db))
    auth = f"Bearer {TOKEN}"
    assert app.handle("GET", "/backups", None)[0] == 401
    code, payload = app.handle("POST", "/backups", auth)
    assert code == 201 and payload["backups"][0]["kind"] == "manual"
    name = payload["backup"]["name"]
    assert app.handle("GET", "/backups", auth)[1]["restore"] == {"state": "idle"}
    assert app.handle("POST", "/backups/../../etc/restore", auth)[0] in (400, 404)
    assert app.handle("DELETE", "/backups/netpulse-manual-20200101-000000.sql.gz", auth)[0] == 404
    code, payload = app.handle("POST", f"/backups/{name}/restore", auth)
    assert code == 202 and payload["restore"]["state"] in ("running", "ok")
    wait_done(app.backups)
    # Aktualizacja i przywracanie się wykluczają
    busy_app = UpdaterApp(settings, launcher=lambda s: None, is_running=lambda s: True, backups=app.backups)
    assert busy_app.handle("POST", f"/backups/{name}/restore", auth)[0] == 409
    code, payload = app.handle("DELETE", f"/backups/{name}", auth)
    assert code == 200 and name not in [b["name"] for b in payload["backups"]]


def test_http_file_download(settings):
    db = FakeDb(content="zawartosc")
    app = UpdaterApp(settings, launcher=lambda s: None, is_running=lambda s: False, backups=make(settings, db))
    name = app.backups.create()["name"]
    server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(app))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        req = urllib.request.Request(f"{base}/backups/{name}/file", headers={"Authorization": f"Bearer {TOKEN}"})
        with urllib.request.urlopen(req, timeout=5) as res:
            assert res.headers["Content-Type"] == "application/gzip"
            assert gzip.decompress(res.read()).decode().strip().endswith("zawartosc")
        with pytest.raises(urllib.error.HTTPError) as no_auth:
            urllib.request.urlopen(f"{base}/backups/{name}/file", timeout=5)
        assert no_auth.value.code == 401
        bad = urllib.request.Request(f"{base}/backups/netpulse-20200101-000000.sql.gz/file", headers={"Authorization": f"Bearer {TOKEN}"})
        with pytest.raises(urllib.error.HTTPError) as missing:
            urllib.request.urlopen(bad, timeout=5)
        assert missing.value.code == 404
        req = urllib.request.Request(f"{base}/backups/{name}", method="DELETE", headers={"Authorization": f"Bearer {TOKEN}"})
        with urllib.request.urlopen(req, timeout=5) as res:
            assert json.loads(res.read())["backups"] == []
    finally:
        server.shutdown()


def test_update_job_prunes_only_update_backups(settings):
    d = settings.backups_dir
    d.mkdir()
    (d / "netpulse-manual-20260101-000000.sql.gz").write_bytes(b"x" * 30)
    for i in range(5):
        (d / f"netpulse-2026010{i}-000000.sql.gz").write_bytes(b"x" * 30)
    bk.prune(settings, "update")
    names = [b["name"] for b in list_backups(settings)]
    assert "netpulse-manual-20260101-000000.sql.gz" in names and len(names) == 4
