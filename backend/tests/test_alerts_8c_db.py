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
    Controller,
    Device,
    DiskMetric,
    Interface,
    InterfaceMetric,
    NotificationChannel,
    SystemMetric,
    TopologyLink,
    User,
)
from netpulse.notifications import Notifier, local_tz  # noqa: E402

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
        await s.execute(delete(Controller))
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
        self.headers: list[dict] = []
        hook = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                hook.received.append(json.loads(body))
                hook.paths.append(self.path)
                hook.headers.append({k.lower(): v for k, v in self.headers.items()})
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


# --- 0.25.0: grupowanie po topologii, ciche godziny, ntfy i e-mail -------------------------------


def test_switch_down_sends_one_message_for_devices_behind(client, hook):
    client.post("/api/notification-channels", json={"name": "Hook", "url": hook.url})
    down = dict(status="down", last_ok_at=NOW - timedelta(seconds=300), last_error="timeout")
    router = add_device("UCG", "10.9.0.1", kind="router", status="up")
    switch = add_device("USW", "10.9.0.2", kind="switch", **down)
    ap = add_device("U6+", "10.9.0.3", kind="ap", **down)
    add_rule(name="offline", kind="device_offline", duration_s=120, severity="critical")

    async def topology():
        async with Session() as s, s.begin():
            c = Controller(name="UniFi", host="10.9.0.1", api_key="k")
            s.add(c)
            await s.flush()
            mac = {router: "aa:00:00:00:00:01", switch: "aa:00:00:00:00:02", ap: "aa:00:00:00:00:03"}
            for dev, port, remote in ((router, 1, switch), (switch, 8, router), (switch, 1, ap), (ap, 1, switch)):
                s.add(TopologyLink(controller_id=c.id, device_id=dev, local_port_idx=port, local_mac=mac[dev], remote_mac=mac[remote], updated_at=NOW))

    run(topology)
    evaluate(Notifier())
    (msg,) = hook.received  # jedna wiadomość o przyczynie
    assert msg["device"] == "USW" and "Za nim nie odpowiada też: U6+" in msg["text"]
    assert {a["title"] for a in alerts(client, "firing")} == {"USW nie odpowiada", "U6+ nie odpowiada"}  # w panelu oba

    async def switch_back():
        async with Session() as s, s.begin():
            (await s.get(Device, switch)).status = "up"

    run(switch_back)
    evaluate(Notifier(), now=NOW + timedelta(seconds=30))
    # Switch wrócił, AP dalej nie odpowiada: teraz osobne powiadomienie o AP
    assert sorted((m["event"], m["device"]) for m in hook.received[1:]) == [("firing", "U6+"), ("resolved", "USW")]


def test_quiet_hours_hold_warning_until_morning(client, hook):
    local = NOW.astimezone(local_tz())
    window = {"quiet_from": (local - timedelta(hours=1)).strftime("%H:%M"), "quiet_to": (local + timedelta(hours=1)).strftime("%H:%M")}
    cid = client.post("/api/notification-channels", json={"name": "Hook", "url": hook.url, **window}).json()["id"]
    add_device(status="down", last_ok_at=NOW - timedelta(seconds=300))
    add_rule(name="offline", kind="device_offline", duration_s=0, severity="warning")
    evaluate(Notifier(now_fn=lambda: NOW))
    assert hook.received == []
    (ch,) = client.get("/api/notification-channels").json()
    assert ch["quiet_pending"] == 1 and ch["quiet_from"] == window["quiet_from"] and ch["timezone"]

    later = NOW + timedelta(hours=3)
    evaluate(Notifier(now_fn=lambda: later), now=later)
    (msg,) = hook.received
    assert msg["event"] == "quiet_summary" and "SRV nie odpowiada" in msg["text"]
    assert client.get("/api/notification-channels").json()[0]["quiet_pending"] == 0
    assert client.patch(f"/api/notification-channels/{cid}", json={"quiet_from": "7:00"}).status_code == 422


def test_ntfy_and_email_channels_api(client, hook):
    base = hook.url.split("/hook/")[0]
    ntfy = client.post("/api/notification-channels", json={"name": "ntfy", "kind": "ntfy", "url": f"{base}/netpulse-dom", "secret": "tk_tajny"})
    assert ntfy.status_code == 201, ntfy.text
    body = ntfy.json()
    assert body["kind"] == "ntfy" and body["has_secret"] and "tk_tajny" not in json.dumps(body)
    res = client.post(f"/api/notification-channels/{body['id']}/test").json()
    assert res == {"ok": True, "error": None}
    assert hook.paths[0] == "/" and hook.received[0]["topic"] == "netpulse-dom" and hook.received[0]["priority"] == 3
    assert hook.headers[0]["authorization"] == "Bearer tk_tajny"
    assert client.patch(f"/api/notification-channels/{body['id']}", json={"secret": ""}).json()["has_secret"] is False
    assert client.patch(f"/api/notification-channels/{body['id']}", json={"url": f"{base}/"}).status_code == 422

    smtp = {"host": "smtp.example.com", "port": 465, "security": "ssl", "username": "ja@example.com", "recipients": ["dom@example.com"]}
    mail = client.post("/api/notification-channels", json={"name": "Mail", "kind": "email", "email": smtp, "secret": "haslo-smtp"}).json()
    assert mail["url_hint"] == "smtp.example.com:465" and mail["email"]["recipients"] == ["dom@example.com"] and mail["has_secret"]
    assert "haslo-smtp" not in json.dumps(mail)
    changed = client.patch(f"/api/notification-channels/{mail['id']}", json={"email": {**smtp, "port": 587, "security": "starttls"}}).json()
    assert changed["url_hint"] == "smtp.example.com:587" and changed["has_secret"]  # hasło zostaje
    webhook = client.post("/api/notification-channels", json={"name": "W", "url": hook.url}).json()
    assert client.patch(f"/api/notification-channels/{webhook['id']}", json={"email": smtp}).status_code == 422
    assert client.patch(f"/api/notification-channels/{webhook['id']}", json={"secret": "x"}).status_code == 422

    async def stored():
        async with Session() as s:
            return (await s.get(NotificationChannel, mail["id"])).secret

    assert run(stored) == "haslo-smtp"
