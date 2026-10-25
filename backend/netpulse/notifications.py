"""Powiadomienia o alertach poza panelem: webhook (JSON przez HTTP POST).

Jeden komunikat działa w popularnych usługach bez dodatkowej konfiguracji: ładunek ma pola `text` (Slack,
Telegram, Mattermost, Home Assistant) i `content` (Discord) oraz pełne dane alertu dla własnych skryptów.
Adres webhooka zawiera zwykle sekret (token), więc nigdy nie wraca do przeglądarki w całości."""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from urllib.parse import urlsplit

import httpx
from sqlalchemy import select, update

from .db import Session
from .db.models import NotificationChannel

log = logging.getLogger("netpulse.notifications")

SEVERITY_RANK = {"info": 0, "warning": 1, "critical": 2}
SEVERITY_ICON = {"info": "ℹ️", "warning": "🟠", "critical": "🔴"}
TIMEOUT_S = 6.0
# Więcej zdarzeń w jednym cyklu (np. padł switch i wszystko za nim) wysyłamy jako jedną wiadomość zbiorczą
SUMMARY_FROM = 4
SUMMARY_LISTED = 10


@dataclass(frozen=True)
class AlertEvent:
    """Zdarzenie alertu do rozesłania: wyzwolenie albo zakończenie."""

    kind: str  # firing | resolved
    severity: str
    title: str
    message: str | None
    device_name: str | None
    value: float | None
    started_at: datetime
    resolved_at: datetime | None = None


def mask_url(url: str) -> str:
    """Adres bez ścieżki i parametrów (tam są tokeny): `https://discord.com/…`."""
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}/…"


def event_text(e: AlertEvent) -> str:
    if e.kind == "resolved":
        return f"✅ Zakończono: {e.title}"
    text = f"{SEVERITY_ICON.get(e.severity, '')} {e.title}".strip()
    return f"{text}\n{e.message}" if e.message else text


def event_payload(e: AlertEvent) -> dict:
    text = event_text(e)
    return {
        "text": text,
        "content": text,
        "event": e.kind,
        "severity": e.severity,
        "title": e.title,
        "message": e.message,
        "device": e.device_name,
        "value": e.value,
        "started_at": e.started_at.isoformat(),
        "resolved_at": e.resolved_at.isoformat() if e.resolved_at else None,
    }


def summary_payload(events: list[AlertEvent]) -> dict:
    firing = [e for e in events if e.kind == "firing"]
    resolved = [e for e in events if e.kind == "resolved"]
    lines = [f"NetPulse: {len(firing)} nowych alertów, {len(resolved)} zakończonych"]
    for e in events[:SUMMARY_LISTED]:
        lines.append(("✅ " if e.kind == "resolved" else f"{SEVERITY_ICON.get(e.severity, '')} ") + e.title)
    if len(events) > SUMMARY_LISTED:
        lines.append(f"…i {len(events) - SUMMARY_LISTED} więcej")
    text = "\n".join(lines)
    return {"text": text, "content": text, "event": "summary", "firing": len(firing), "resolved": len(resolved)}


def select_events(channel: NotificationChannel, events: list[AlertEvent]) -> list[AlertEvent]:
    """Zdarzenia dla kanału: od jego minimalnej ważności, zakończenia tylko gdy je włączył."""
    floor = SEVERITY_RANK.get(channel.min_severity, 0)
    return [
        e
        for e in events
        if SEVERITY_RANK.get(e.severity, 0) >= floor and (e.kind == "firing" or channel.notify_resolved)
    ]


class Notifier:
    def __init__(self, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.transport = transport

    async def _post(self, url: str, payload: dict) -> None:
        async with httpx.AsyncClient(timeout=TIMEOUT_S, transport=self.transport, follow_redirects=False) as client:
            res = await client.post(url, json=payload)
        if res.status_code >= 400:
            raise RuntimeError(f"HTTP {res.status_code}")

    async def _deliver(self, channel_id: int, url: str, payloads: list[dict]) -> str | None:
        """Wysyła ładunki po kolei; zwraca opis błędu albo None. Wynik zapisuje przy kanale."""
        error = None
        try:
            for payload in payloads:
                await self._post(url, payload)
        except Exception as exc:  # sieć, TLS, limit czasu, kod błędu usługi
            error = f"{type(exc).__name__}: {exc}"[:500]
            log.warning("Powiadomienie (kanał %s) nie dotarło: %s", channel_id, error)
        async with Session() as session, session.begin():
            await session.execute(
                update(NotificationChannel)
                .where(NotificationChannel.id == channel_id)
                .values(last_status="error" if error else "ok", last_error=error, last_sent_at=datetime.now(UTC))
            )
        return error

    async def send(self, events: list[AlertEvent]) -> None:
        """Rozsyła zdarzenia ze wszystkich włączonych kanałów. Nigdy nie rzuca wyjątku (nie może zepsuć cyklu kolektora)."""
        if not events:
            return
        try:
            async with Session() as session:
                channels = (await session.scalars(select(NotificationChannel).where(NotificationChannel.enabled))).all()
            jobs = []
            for channel in channels:
                chosen = select_events(channel, events)
                if not chosen:
                    continue
                payloads = [summary_payload(chosen)] if len(chosen) >= SUMMARY_FROM else [event_payload(e) for e in chosen]
                jobs.append(self._deliver(channel.id, channel.url, payloads))
            if jobs:
                await asyncio.gather(*jobs)
        except Exception:
            log.exception("Błąd wysyłania powiadomień")

    async def send_test(self, channel_id: int, url: str) -> str | None:
        """Wiadomość próbna z formularza; zwraca opis błędu albo None."""
        text = "✅ NetPulse: powiadomienia działają"
        return await self._deliver(channel_id, url, [{"text": text, "content": text, "event": "test"}])
