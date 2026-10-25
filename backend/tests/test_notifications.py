"""Powiadomienia o alertach: ładunki, wybór zdarzeń dla kanału i wysyłka (bez bazy)."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from zoneinfo import ZoneInfo

import httpx
import pytest
from pydantic import ValidationError

from netpulse.alerts import METRICS, PER_DEVICE_METRICS, SYSTEM_METRICS, format_value
from netpulse.api.notifications import ChannelCreate, ChannelUpdate
from netpulse.db.models import NotificationChannel
from netpulse.notifications import (
    SUMMARY_LISTED,
    AlertEvent,
    Notifier,
    event_payload,
    mask_url,
    select_events,
    summary_payload,
)

T0 = datetime(2026, 10, 25, 12, 0, tzinfo=UTC)


def event(kind="firing", severity="warning", title="USW nie odpowiada", **kw) -> AlertEvent:
    return AlertEvent(kind, severity, title, kw.get("message"), kw.get("device"), kw.get("value"), T0, kw.get("resolved_at"))


def channel(**kw) -> NotificationChannel:
    return NotificationChannel(name="k", url="https://example.com/x", min_severity="warning", notify_resolved=True, **kw)


def test_mask_url_hides_path_and_tokens():
    assert mask_url("https://discord.com/api/webhooks/123/SEKRETNY-TOKEN?wait=true") == "https://discord.com/…"
    assert mask_url("http://192.168.1.5:8123/api/webhook/abc") == "http://192.168.1.5:8123/…"


def test_payload_works_for_slack_discord_and_scripts():
    p = event_payload(event(severity="critical", message="timeout", device="USW", value=300.0))
    assert p["text"] == p["content"] == "🔴 USW nie odpowiada\ntimeout"  # Slack/Telegram: text, Discord: content
    assert p["event"] == "firing" and p["severity"] == "critical" and p["device"] == "USW" and p["value"] == 300.0
    assert p["started_at"] == T0.isoformat() and p["resolved_at"] is None


def test_resolved_payload_says_it_ended():
    p = event_payload(event(kind="resolved", resolved_at=T0))
    assert p["text"] == "✅ Zakończono: USW nie odpowiada" and p["event"] == "resolved" and p["resolved_at"] == T0.isoformat()


def test_channel_severity_floor_and_resolved_switch():
    events = [event(severity="info", title="a"), event(severity="warning", title="b"), event(severity="critical", title="c"),
              event(kind="resolved", severity="critical", title="d")]
    assert [e.title for e in select_events(channel(), events)] == ["b", "c", "d"]
    only_critical = channel()
    only_critical.min_severity, only_critical.notify_resolved = "critical", False
    assert [e.title for e in select_events(only_critical, events)] == ["c"]


def test_summary_for_many_events_is_truncated():
    events = [event(title=f"alert {i}") for i in range(SUMMARY_LISTED + 5)] + [event(kind="resolved", title="stary")]
    p = summary_payload(events)
    assert p["event"] == "summary" and p["firing"] == SUMMARY_LISTED + 5 and p["resolved"] == 1
    lines = p["text"].splitlines()
    assert lines[0] == f"NetPulse: {SUMMARY_LISTED + 5} nowych alertów, 1 zakończonych"
    assert len(lines) == 1 + SUMMARY_LISTED + 1 and lines[-1] == "…i 6 więcej"


def post_via(handler, url="https://hooks.example.com/abc"):
    async def go():
        await Notifier(transport=httpx.MockTransport(handler))._post(url, {"text": "x"})

    asyncio.run(go())


def test_post_sends_json_and_fails_on_http_error():
    seen = []

    def ok(request: httpx.Request) -> httpx.Response:
        seen.append((str(request.url), request.headers["content-type"], request.content))
        return httpx.Response(204)

    post_via(ok)
    assert seen[0][0] == "https://hooks.example.com/abc" and seen[0][1] == "application/json" and b'"text"' in seen[0][2]
    with pytest.raises(RuntimeError, match="HTTP 404"):
        post_via(lambda _r: httpx.Response(404))


def test_channel_url_validation():
    assert ChannelCreate(name="x", url="https://hooks.example.com/a").url == "https://hooks.example.com/a"
    assert ChannelCreate(name="x", url="  http://192.168.1.5:8123/hook ").url == "http://192.168.1.5:8123/hook"
    for bad in ("ftp://example.com/x", "javascript:alert(1)", "https://", "nie-adres-www"):
        with pytest.raises(ValidationError):
            ChannelCreate(name="x", url=bad)
    with pytest.raises(ValidationError):
        ChannelUpdate(url="ftp://example.com/x")
    assert ChannelUpdate().model_dump(exclude_unset=True) == {}  # brak adresu = bez zmian


def test_new_metrics_are_defined_consistently():
    for m in ("disk_used_percent", "port_errors", "system_cpu_percent", "system_mem_used_percent", "system_disk_used_percent"):
        assert m in METRICS
    assert {"disk_used_percent", "port_errors"} <= set(PER_DEVICE_METRICS)
    assert not set(SYSTEM_METRICS) & set(PER_DEVICE_METRICS)  # serwer NetPulse jest globalny
    assert format_value("disk_used_percent", 92.04) == "92,0%"
    assert format_value("port_errors", 5.0) == "5"


# --- ntfy, e-mail, ciche godziny (0.25.0) ---------------------------------------------------------


def test_quiet_hours_window_and_midnight(monkeypatch):
    from netpulse.notifications import in_quiet_hours

    monkeypatch.setattr("netpulse.notifications.local_tz", lambda: ZoneInfo("Europe/Warsaw"))
    # 25.10.2026 23:30 UTC = 26.10 00:30 w Warszawie (po zmianie czasu: UTC+1)
    night = datetime(2026, 10, 25, 23, 30, tzinfo=UTC)
    day = datetime(2026, 10, 26, 9, 0, tzinfo=UTC)
    assert in_quiet_hours("22:00", "07:00", night) and not in_quiet_hours("22:00", "07:00", day)
    assert in_quiet_hours("09:00", "17:00", day) and not in_quiet_hours("09:00", "17:00", night)
    assert not in_quiet_hours("22:00", "22:00", night) and not in_quiet_hours(None, "07:00", night)


def quiet_channel(**kw) -> NotificationChannel:
    c = channel(quiet_from="22:00", quiet_to="07:00", quiet_critical=True, **kw)
    c.quiet_backlog = kw.get("quiet_backlog")
    return c


def test_quiet_hours_hold_non_critical_and_send_digest_after(monkeypatch):
    monkeypatch.setattr("netpulse.notifications.local_tz", lambda: ZoneInfo("UTC"))
    night, morning = datetime(2026, 10, 26, 1, 0, tzinfo=UTC), datetime(2026, 10, 26, 7, 5, tzinfo=UTC)
    c = quiet_channel()
    messages, backlog = Notifier().plan(c, [event(title="CPU wysoko"), event(severity="critical", title="Router nie odpowiada")], night)
    assert [m.title for m in messages] == ["Router nie odpowiada"]  # krytyczne przechodzą
    assert backlog == [{"kind": "firing", "severity": "warning", "title": "CPU wysoko"}]

    c.quiet_backlog = backlog
    messages, backlog = Notifier().plan(c, [event(kind="resolved", title="CPU wysoko")], night)
    assert messages == [] and len(backlog) == 2

    c.quiet_backlog = backlog
    messages, backlog = Notifier().plan(c, [], morning)
    assert backlog is None and len(messages) == 1
    assert messages[0].title == "NetPulse po cichych godzinach: 1 alertów, 1 zakończonych"
    assert "🟠 CPU wysoko" in messages[0].text and "✅ CPU wysoko" in messages[0].text

    c.quiet_backlog, c.quiet_critical = None, False
    messages, backlog = Notifier().plan(c, [event(severity="critical", title="x")], night)
    assert messages == [] and len(backlog) == 1  # bez wyjątku dla krytycznych


def test_quiet_backlog_is_capped(monkeypatch):
    from netpulse.notifications import BACKLOG_MAX

    monkeypatch.setattr("netpulse.notifications.local_tz", lambda: ZoneInfo("UTC"))
    night = datetime(2026, 10, 26, 1, 0, tzinfo=UTC)
    c = quiet_channel()
    _, backlog = Notifier().plan(c, [event(title=f"a{i}") for i in range(BACKLOG_MAX + 5)], night)
    assert len(backlog) == BACKLOG_MAX + 1 and backlog[-1] == {"skipped": 5}
    c.quiet_backlog = backlog
    _, backlog = Notifier().plan(c, [event(title="b")], night)
    assert backlog[-1] == {"skipped": 6}
    c.quiet_backlog = backlog
    messages, _ = Notifier().plan(c, [], datetime(2026, 10, 26, 8, 0, tzinfo=UTC))
    assert messages[0].payload["firing"] == BACKLOG_MAX + 6


def test_ntfy_publishes_json_with_priority_and_token():
    from netpulse.notifications import event_message, ntfy_target

    assert ntfy_target("https://ntfy.sh/netpulse-dom") == ("https://ntfy.sh/", "netpulse-dom")
    assert ntfy_target("http://192.168.1.5:8080/ntfy/alerty/") == ("http://192.168.1.5:8080/ntfy/", "alerty")
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200)

    c = NotificationChannel(name="ntfy", kind="ntfy", url="https://ntfy.sh/netpulse-dom", secret="tk_abc")
    asyncio.run(Notifier(transport=httpx.MockTransport(handler))._send_one(c, event_message(event(severity="critical", message="timeout"))))
    import json

    body = json.loads(seen[0].content)
    assert str(seen[0].url) == "https://ntfy.sh/" and seen[0].headers["authorization"] == "Bearer tk_abc"
    assert body == {"topic": "netpulse-dom", "title": "USW nie odpowiada", "message": "🔴 USW nie odpowiada\ntimeout", "priority": 5, "tags": ["rotating_light"]}


def test_email_goes_through_smtp_sender():
    from netpulse.notifications import event_message

    sent = []
    config = {"host": "smtp.example.com", "port": 587, "security": "starttls", "username": "ja@example.com", "sender": None, "recipients": ["a@example.com", "b@example.com"]}
    c = NotificationChannel(name="mail", kind="email", config=config, secret="haslo")
    notifier = Notifier(smtp=lambda cfg, password, msg: sent.append((cfg, password, msg)))
    asyncio.run(notifier._send_one(c, event_message(event(kind="resolved"))))
    cfg, password, msg = sent[0]
    assert cfg["host"] == "smtp.example.com" and password == "haslo"
    assert msg["Subject"] == "[NetPulse] Zakończono: USW nie odpowiada"
    assert msg["From"] == "ja@example.com" and msg["To"] == "a@example.com, b@example.com"
    assert "✅ Zakończono: USW nie odpowiada" in msg.get_content()


def test_channel_kinds_validation():
    email = {"host": "smtp.example.com", "recipients": ["ja@example.com"]}
    c = ChannelCreate(name="m", kind="email", email=email, url="https://ignored.example.com/x", secret="haslo")
    assert c.url is None and c.email.port == 587 and c.email.security == "starttls" and c.secret == "haslo"
    assert ChannelCreate(name="n", kind="ntfy", url="https://ntfy.sh/dom", secret="").secret is None
    assert ChannelCreate(name="w", url="https://hooks.example.com/a", secret="x").secret is None  # webhook: sekret jest w adresie
    for bad in (
        {"kind": "email"},
        {"kind": "email", "email": {"host": "smtp", "recipients": []}},
        {"kind": "email", "email": {"host": "smtp", "recipients": ["nie-adres"]}},
        {"kind": "ntfy", "url": "https://ntfy.sh/"},
        {"kind": "ntfy"},
        {"kind": "sms", "url": "https://x.example.com/a"},
        {"url": "https://hooks.example.com/a", "quiet_from": "25:00"},
    ):
        with pytest.raises(ValidationError):
            ChannelCreate(name="x", **bad)
    assert ChannelCreate(name="x", url="https://h.example.com/a", quiet_from="22:00", quiet_to="").quiet_to is None


def test_upstream_parents_and_down_root():
    from netpulse.alerts import down_root, upstream_parents
    from netpulse.db.models import Device, TopologyLink

    devices = {
        1: Device(id=1, name="UCG", kind="router", status="up"),
        2: Device(id=2, name="USW", kind="switch", status="down"),
        3: Device(id=3, name="U6+", kind="ap", status="down"),
        4: Device(id=4, name="Sam", kind="switch", status="down"),
    }
    mac = {1: "aa:00:00:00:00:01", 2: "aa:00:00:00:00:02", 3: "aa:00:00:00:00:03"}
    links = [
        TopologyLink(device_id=1, local_port_idx=1, local_mac=mac[1], remote_mac=mac[2]),
        TopologyLink(device_id=2, local_port_idx=8, local_mac=mac[2], remote_mac=mac[1]),
        TopologyLink(device_id=2, local_port_idx=1, local_mac=mac[2], remote_mac=mac[3]),
        TopologyLink(device_id=3, local_port_idx=1, local_mac=mac[3], remote_mac="bb:00:00:00:00:99"),  # obcy sąsiad
    ]
    parent = upstream_parents(devices, links)
    assert parent == {2: 1, 3: 2}
    assert down_root(3, parent, devices) == 2  # AP za niedziałającym switchem
    assert down_root(2, parent, devices) is None  # router działa – switch jest przyczyną
    assert down_root(4, parent, devices) is None  # poza mapą
    assert upstream_parents({k: v for k, v in devices.items() if k != 1}, links) == {}  # bez routera nie zgadujemy
