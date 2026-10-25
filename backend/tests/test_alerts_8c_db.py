"""Etap 8c na prawdziwej bazie: reguły dysku, błędów portów i serwera NetPulse oraz powiadomienia webhookiem.

Uruchamiane, gdy ustawiono NETPULSE_TEST_DB=1 i NETPULSE_DATABASE_URL (CI ma usługę bazy).
"""

from __future__ import annotations

import asyncio
import json
import os
import threading
from datetime import UTC, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

if os.environ.get("NETPULSE_TEST_DB") != "1":
    pytest.skip("brak testowej bazy (NETPULSE_TEST_DB=1)", allow_module_level=True)

from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import delete, select  # noqa: E402

from netpulse.alerts import AlertEngine  # noqa: E402
from netpulse.api import app  # noqa: E402
from netpulse.api.security import login_limiter  # noqa: E402
from netpulse.db import Session, engine, init_db  # noqa: E402
from netpulse.db.models import (  # noqa: E402
    Alert,
    AlertRule,
    Device,
    DiskMetric,
    Interface,
    InterfaceMetric,
    NotificationChannel,
    SystemMetric,
    User,
)
from netpulse.notifications import Notifier  # noqa: E402

ADMIN = {"username": "admin", "password": "haslo-testowe-1"}
NOW = datetime.now(UTC).replace(microsecond=0)


def run(coro_fn):
    async def wrapper():
        try:
            return await coro_fn()
        finally:
            await engine.dispose()

    return asyncio.run(wrapper())


async def _reset():
    await init_db()
    async with Session() as s, s.begin():
        await s.execute(delete(Alert))
        await s.execute(delete(AlertRule))
        await s.execute(delete(NotificationChannel))
        await s.execute(delete(SystemMetric))
        await s.execute(delete(Device))
        await s.execute(delete(User))


@pytest.fixture
def client():
    login_limiter._failures.clear()
    run(_reset)
    with TestClient(app) as c:
        assert c.post("/api/auth/setup", json=ADMIN).status_code == 201
        yield c
    run(_reset)


def evaluate(notifier: Notifier | None = None, now: datetime = NOW):
    async def go():
        return await AlertEngine(now_fn=lambda: now, notifier=notifier).evaluate()

    return run(go)


def alerts(client, state="all"):
    return client.get("/api/alerts", params={"state": state}).json()


def add_device(name="SRV", host="10.9.0.1", **kw) -> int:
    async def go():
        async with Session() as s, s.begin():
            d = Device(name=name, host=host, community="public", **kw)
            s.add(d)
            await s.flush()
            return d.id

    return run(go)


def add_rule(**kw) -> int:
    async def go():
        async with Session() as s, s.begin():
            r = AlertRule(**kw)
            s.add(r)
            await s.flush()
            return r.id

    return run(go)


def add_rows(rows) -> None:
    async def go():
        async with Session() as s, s.begin():
            s.add_all(rows)

    run(go)


def test_disk_rule_alerts_per_partition(client):
    dev = add_device(status="up")
    add_rule(name="Dysk", kind="metric", metric="disk_used_percent", op=">", threshold=90, duration_s=300, severity="critical")
    rows = []
    for i in range(12):  # 5,5 minuty próbek co 30 s
        t = NOW - timedelta(seconds=30 * (11 - i))
        rows.append(DiskMetric(time=t, device_id=dev, mount="/mnt/data", total_bytes=1000, used_bytes=950))
        rows.append(DiskMetric(time=t, device_id=dev, mount="/", total_bytes=1000, used_bytes=400))
    add_rows(rows)
    events = evaluate()
    (a,) = alerts(client)
    assert a["severity"] == "critical" and a["device_id"] == dev
    assert "dysk /mnt/data zajęty w 95,0%" in a["title"] and "SRV" in a["title"]
    assert [e.kind for e in events] == ["firing"] and events[0].device_name == "SRV"
    evaluate()
    assert len(alerts(client)) == 1  # partycja „/” poniżej progu, a drugi przebieg nie dubluje


def test_port_errors_rule_ignores_first_sample_and_hidden_ports(client):
    dev = add_device(status="up")

    async def ports():
        async with Session() as s, s.begin():
            visible = Interface(device_id=dev, if_index=1, name="0/1", label="Port 1", alias="NAS")
            hidden = Interface(device_id=dev, if_index=2, name="lo", label="lo", hidden=True)
            s.add_all([visible, hidden])
            await s.flush()
            return visible.id, hidden.id

    visible, hidden = run(ports)
    add_rule(name="Błędy", kind="metric", metric="port_errors", op=">", threshold=0, duration_s=0)
    add_rows([InterfaceMetric(time=NOW, interface_id=visible, in_errors=None, out_errors=None)])  # pierwszy odczyt
    add_rows([InterfaceMetric(time=NOW, interface_id=hidden, in_errors=9, out_errors=9)])
    evaluate()
    assert alerts(client) == []

    add_rows([InterfaceMetric(time=NOW + timedelta(seconds=30), interface_id=visible, in_errors=3, out_errors=2)])
    evaluate(now=NOW + timedelta(seconds=30))
    (a,) = alerts(client)
    assert "Błędy na porcie NAS (SRV): 5" in a["title"]


def test_system_rules_cover_netpulse_server(client):
    add_rule(name="Dysk serwera", kind="metric", metric="system_disk_used_percent", op=">", threshold=90, duration_s=0, severity="critical")
    add_rule(name="CPU serwera", kind="metric", metric="system_cpu_percent", op=">", threshold=90, duration_s=0)
    add_rows([SystemMetric(time=NOW, cpu_percent=20.0, disk_used_percent=93.0)])
    evaluate()
    (a,) = alerts(client)
    assert a["title"] == "Serwer NetPulse: dysk 93,0%" and a["device_id"] is None and a["severity"] == "critical"

    add_rows([SystemMetric(time=NOW + timedelta(seconds=30), cpu_percent=20.0, disk_used_percent=50.0)])
    evaluate(now=NOW + timedelta(seconds=30))
    assert [x["state"] for x in alerts(client)] == ["resolved"]


def test_rule_validation_for_new_metrics(client):
    dev = add_device(status="up")
    ok = client.post("/api/alert-rules", json={"name": "d", "kind": "metric", "metric": "disk_used_percent", "op": ">", "threshold": 90, "device_id": dev})
    assert ok.status_code == 201
    bad = client.post("/api/alert-rules", json={"name": "s", "kind": "metric", "metric": "system_cpu_percent", "op": ">", "threshold": 90, "device_id": dev})
    assert bad.status_code == 422
    metrics = {m["metric"]: m for m in client.get("/api/alert-rules/metrics").json()}
    assert metrics["disk_used_percent"]["per_device"] and metrics["port_errors"]["per_device"]
    assert not metrics["system_cpu_percent"]["per_device"]


# --- kanały powiadomień: lokalny serwer udaje webhook ---------------------------------------------


class Hook:
    def __init__(self, status: int = 200) -> None:
        self.received: list[dict] = []
        self.paths: list[str] = []
        hook = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                hook.received.append(json.loads(body))
                hook.paths.append(self.path)
                self.send_response(status)
                self.end_headers()

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_port}/hook/SEKRET?token=abc"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def hook():
    h = Hook()
    yield h
    h.close()


def test_channel_api_never_returns_the_url(client, hook):
    created = client.post("/api/notification-channels", json={"name": "Discord", "url": hook.url})
    assert created.status_code == 201
    body = created.json()
    assert "url" not in body and body["url_hint"].startswith("http://127.0.0.1:") and "SEKRET" not in json.dumps(body)
    assert body["min_severity"] == "warning" and body["notify_resolved"] and body["enabled"]
    cid = body["id"]

    assert client.patch(f"/api/notification-channels/{cid}", json={"name": "Telegram", "min_severity": "critical"}).json()["name"] == "Telegram"
    assert client.patch(f"/api/notification-channels/{cid}", json={"name": None}).status_code == 422
    assert client.post("/api/notification-channels", json={"name": "x", "url": "ftp://x/y"}).status_code == 422
    assert [c["name"] for c in client.get("/api/notification-channels").json()] == ["Telegram"]
    assert client.delete(f"/api/notification-channels/{cid}").status_code == 204
    assert client.delete(f"/api/notification-channels/{cid}").status_code == 404


def test_channel_test_sends_message_and_records_result(client, hook):
    cid = client.post("/api/notification-channels", json={"name": "Hook", "url": hook.url}).json()["id"]
    res = client.post(f"/api/notification-channels/{cid}/test").json()
    assert res == {"ok": True, "error": None}
    assert hook.received[0]["event"] == "test" and "działają" in hook.received[0]["text"]
    assert hook.paths[0] == "/hook/SEKRET?token=abc"  # pełny adres użyty po stronie serwera
    (ch,) = client.get("/api/notification-channels").json()
    assert ch["last_status"] == "ok" and ch["last_error"] is None and ch["last_sent_at"]


def test_failed_delivery_is_recorded_on_the_channel(client):
    bad = Hook(status=500)
    try:
        cid = client.post("/api/notification-channels", json={"name": "Zepsuty", "url": bad.url}).json()["id"]
        res = client.post(f"/api/notification-channels/{cid}/test").json()
        assert res["ok"] is False and "HTTP 500" in res["error"]
        (ch,) = client.get("/api/notification-channels").json()
        assert ch["last_status"] == "error" and "HTTP 500" in ch["last_error"]
    finally:
        bad.close()


def test_alert_events_reach_the_webhook(client, hook):
    client.post("/api/notification-channels", json={"name": "Hook", "url": hook.url})
    dev = add_device(status="down", last_ok_at=NOW - timedelta(seconds=300), last_error="timeout")
    add_rule(name="offline", kind="device_offline", duration_s=120, severity="critical")
    evaluate(Notifier())
    (msg,) = hook.received
    assert msg["event"] == "firing" and msg["severity"] == "critical" and msg["device"] == "SRV" and "nie odpowiada" in msg["text"]

    evaluate(Notifier())
    assert len(hook.received) == 1  # ten sam alert nie wysyła się drugi raz

    async def back():
        async with Session() as s, s.begin():
            (await s.get(Device, dev)).status = "up"

    run(back)
    evaluate(Notifier(), now=NOW + timedelta(seconds=30))
    assert [m["event"] for m in hook.received] == ["firing", "resolved"]
    assert hook.received[1]["text"].startswith("✅ Zakończono")


def test_channel_filters_by_severity_and_can_skip_resolved(client, hook):
    client.post("/api/notification-channels", json={"name": "Tylko krytyczne", "url": hook.url, "min_severity": "critical", "notify_resolved": False})
    add_device(status="down", last_ok_at=NOW - timedelta(seconds=300))
    add_rule(name="ostrzeżenie", kind="device_offline", duration_s=0, severity="warning")
    evaluate(Notifier())
    assert hook.received == []  # ważność warning < critical


def test_channel_management_requires_login():
    with TestClient(app) as c:
        assert c.get("/api/notification-channels").status_code == 401
        assert c.post("/api/notification-channels", json={"name": "x", "url": "https://x.example/y"}).status_code == 401


def test_disabled_channel_gets_nothing(client, hook):
    cid = client.post("/api/notification-channels", json={"name": "Hook", "url": hook.url}).json()["id"]
    client.patch(f"/api/notification-channels/{cid}", json={"enabled": False})
    add_device(status="down", last_ok_at=NOW - timedelta(seconds=300))
    add_rule(name="offline", kind="device_offline", duration_s=0, severity="critical")
    evaluate(Notifier())
    assert hook.received == []
    assert run(_alert_count) == 1  # alert w panelu powstał mimo wyłączonego kanału


async def _alert_count() -> int:
    async with Session() as s:
        return len((await s.scalars(select(Alert))).all())
