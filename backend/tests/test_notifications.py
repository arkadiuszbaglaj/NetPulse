"""Powiadomienia o alertach: ładunki, wybór zdarzeń dla kanału i wysyłka (bez bazy)."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime

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
