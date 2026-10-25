"""Powiadomienia o alertach poza panelem: webhook (JSON przez HTTP POST), ntfy i e-mail (SMTP).

Webhook: jeden komunikat działa w popularnych usługach bez dodatkowej konfiguracji – ładunek ma pola `text` (Slack,
Telegram, Mattermost, Home Assistant) i `content` (Discord) oraz pełne dane alertu dla własnych skryptów.
ntfy: adres tematu (np. `https://ntfy.sh/moj-temat`), opcjonalnie token dostępu; priorytet z ważności alertu.
E-mail: SMTP ze STARTTLS, SSL albo bez szyfrowania (serwer w sieci lokalnej).

Ciche godziny kanału: w oknie (np. 22:00–07:00, strefa TZ serwera) przechodzą tylko alerty krytyczne, reszta
czeka w `quiet_backlog` i po ciszy przychodzi jedną wiadomością zbiorczą.
Adres webhooka, token ntfy i hasło SMTP to sekrety, więc nigdy nie wracają do przeglądarki."""

from __future__ import annotations

import asyncio
import logging
import smtplib
import ssl
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, time
from email.message import EmailMessage
from email.utils import formatdate, make_msgid
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx
from sqlalchemy import select, update

from .config import settings
from .db import Session
from .db.models import NotificationChannel

log = logging.getLogger("netpulse.notifications")

KINDS = ("webhook", "ntfy", "email")
SEVERITY_RANK = {"info": 0, "warning": 1, "critical": 2}
SEVERITY_ICON = {"info": "ℹ️", "warning": "🟠", "critical": "🔴"}
# ntfy: priorytet 1–5 i tagi (tagi będące nazwami emoji ntfy pokazuje jako ikonę)
NTFY_PRIORITY = {"info": 3, "warning": 4, "critical": 5}
NTFY_TAGS = {"info": ["information_source"], "warning": ["warning"], "critical": ["rotating_light"]}
TIMEOUT_S = 6.0
SMTP_TIMEOUT_S = 15.0
# Więcej zdarzeń w jednym cyklu (np. padł switch i wszystko za nim) wysyłamy jako jedną wiadomość zbiorczą
SUMMARY_FROM = 4
SUMMARY_LISTED = 10
# Zaległości z cichych godzin: tyle pozycji pamiętamy (reszta tylko jako liczba)
BACKLOG_MAX = 200


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


@dataclass(frozen=True)
class Message:
    """Jedna wiadomość w postaci niezależnej od kanału: tytuł (temat e-maila, tytuł ntfy), treść i ładunek webhooka."""

    title: str
    text: str
    severity: str
    payload: dict = field(default_factory=dict)


def mask_url(url: str | None) -> str:
    """Adres bez ścieżki i parametrów (tam są tokeny): `https://discord.com/…`."""
    if not url:
        return ""
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


def summary_lines(events: list[AlertEvent], header: str) -> str:
    lines = [header]
    for e in events[:SUMMARY_LISTED]:
        lines.append(("✅ " if e.kind == "resolved" else f"{SEVERITY_ICON.get(e.severity, '')} ") + e.title)
    if len(events) > SUMMARY_LISTED:
        lines.append(f"…i {len(events) - SUMMARY_LISTED} więcej")
    return "\n".join(lines)


def summary_payload(events: list[AlertEvent]) -> dict:
    firing = [e for e in events if e.kind == "firing"]
    resolved = [e for e in events if e.kind == "resolved"]
    text = summary_lines(events, f"NetPulse: {len(firing)} nowych alertów, {len(resolved)} zakończonych")
    return {"text": text, "content": text, "event": "summary", "firing": len(firing), "resolved": len(resolved)}


def top_severity(events: list[AlertEvent]) -> str:
    firing = [e.severity for e in events if e.kind == "firing"] or ["info"]
    return max(firing, key=lambda s: SEVERITY_RANK.get(s, 0))


def event_message(e: AlertEvent) -> Message:
    title = f"Zakończono: {e.title}" if e.kind == "resolved" else e.title
    return Message(title=title, text=event_text(e), severity="info" if e.kind == "resolved" else e.severity, payload=event_payload(e))


def summary_message(events: list[AlertEvent]) -> Message:
    payload = summary_payload(events)
    return Message(title=payload["text"].splitlines()[0], text=payload["text"], severity=top_severity(events), payload=payload)


def backlog_item(e: AlertEvent) -> dict:
    return {"kind": e.kind, "severity": e.severity, "title": e.title}


def digest_message(backlog: list[dict], skipped: int = 0) -> Message:
    """Wiadomość po cichych godzinach: co się działo, gdy powiadomienia czekały."""
    events = [AlertEvent(i.get("kind", "firing"), i.get("severity", "info"), i.get("title", "?"), None, None, None, datetime.now(UTC)) for i in backlog]
    firing = sum(1 for e in events if e.kind == "firing")
    resolved = len(events) - firing
    header = f"NetPulse po cichych godzinach: {firing + skipped} alertów, {resolved} zakończonych"
    text = summary_lines(events, header)
    if skipped:
        text += f"\n(+{skipped} niezapisanych)"
    payload = {"text": text, "content": text, "event": "quiet_summary", "firing": firing + skipped, "resolved": resolved}
    return Message(title=header, text=text, severity=top_severity(events), payload=payload)


def probe_message() -> Message:
    text = "✅ NetPulse: powiadomienia działają"
    return Message(title="NetPulse: powiadomienia działają", text=text, severity="info", payload={"text": text, "content": text, "event": "test"})


def select_events(channel: NotificationChannel, events: list[AlertEvent]) -> list[AlertEvent]:
    """Zdarzenia dla kanału: od jego minimalnej ważności, zakończenia tylko gdy je włączył."""
    floor = SEVERITY_RANK.get(channel.min_severity, 0)
    return [
        e
        for e in events
        if SEVERITY_RANK.get(e.severity, 0) >= floor and (e.kind == "firing" or channel.notify_resolved)
    ]


def parse_hhmm(value: str | None) -> time | None:
    if not value:
        return None
    try:
        hours, minutes = value.split(":")
        return time(int(hours), int(minutes))
    except ValueError:
        return None


def local_tz() -> ZoneInfo:
    try:
        return ZoneInfo(settings.timezone)
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo("UTC")


def in_quiet_hours(quiet_from: str | None, quiet_to: str | None, now: datetime) -> bool:
    """Czy `now` (dowolna strefa) wypada w cichych godzinach liczonych w strefie serwera. Okno może przechodzić
    przez północ (22:00–07:00). Ten sam początek i koniec albo brak któregoś = bez cichych godzin."""
    start, end = parse_hhmm(quiet_from), parse_hhmm(quiet_to)
    if start is None or end is None or start == end:
        return False
    t = now.astimezone(local_tz()).time()
    return start <= t < end if start < end else t >= start or t < end


def split_quiet(channel: NotificationChannel, events: list[AlertEvent], now: datetime) -> tuple[list[AlertEvent], list[AlertEvent]]:
    """(do wysłania teraz, do zaległości). Poza cichymi godzinami wszystko idzie od razu."""
    if not in_quiet_hours(channel.quiet_from, channel.quiet_to, now):
        return events, []
    if channel.quiet_critical:
        return [e for e in events if e.severity == "critical"], [e for e in events if e.severity != "critical"]
    return [], events


def ntfy_target(url: str) -> tuple[str, str]:
    """Adres tematu ntfy → (adres serwera, temat). Publikujemy JSON-em na adres serwera, bo nagłówki HTTP
    (Title) nie przenoszą polskich znaków."""
    base, _, topic = url.rstrip("/").rpartition("/")
    return base + "/", topic


SmtpSender = Callable[[dict, str | None, EmailMessage], None]


def smtp_send(config: dict, password: str | None, msg: EmailMessage) -> None:
    """Wysyłka przez SMTP (blokująca – wołana w wątku)."""
    host, port = config["host"], int(config.get("port") or 587)
    security = config.get("security", "starttls")
    context = ssl.create_default_context()
    if security == "ssl":
        server: smtplib.SMTP = smtplib.SMTP_SSL(host, port, timeout=SMTP_TIMEOUT_S, context=context)
    else:
        server = smtplib.SMTP(host, port, timeout=SMTP_TIMEOUT_S)
    with server:
        if security == "starttls":
            server.starttls(context=context)
        if config.get("username"):
            server.login(config["username"], password or "")
        server.send_message(msg)


def email_message(config: dict, m: Message) -> EmailMessage:
    msg = EmailMessage()
    msg["Subject"] = f"[NetPulse] {m.title}"
    msg["From"] = config.get("sender") or config.get("username") or "netpulse@localhost"
    msg["To"] = ", ".join(config.get("recipients") or [])
    msg["Date"] = formatdate(localtime=True)
    msg["Message-ID"] = make_msgid(domain="netpulse")
    msg.set_content(m.text + "\n\n— NetPulse")
    return msg


class Notifier:
    def __init__(self, transport: httpx.AsyncBaseTransport | None = None, smtp: SmtpSender | None = None, now_fn=lambda: datetime.now(UTC)) -> None:
        self.transport = transport
        self.smtp = smtp or smtp_send
        self.now_fn = now_fn

    async def _post(self, url: str, payload: dict, headers: dict | None = None) -> None:
        async with httpx.AsyncClient(timeout=TIMEOUT_S, transport=self.transport, follow_redirects=False) as client:
            res = await client.post(url, json=payload, headers=headers)
        if res.status_code >= 400:
            raise RuntimeError(f"HTTP {res.status_code}")

    async def _send_one(self, channel: NotificationChannel, m: Message) -> None:
        if channel.kind == "ntfy":
            base, topic = ntfy_target(channel.url or "")
            body = {"topic": topic, "title": m.title, "message": m.text, "priority": NTFY_PRIORITY.get(m.severity, 3), "tags": NTFY_TAGS.get(m.severity, [])}
            headers = {"Authorization": f"Bearer {channel.secret}"} if channel.secret else None
            await self._post(base, body, headers)
        elif channel.kind == "email":
            await asyncio.to_thread(self.smtp, channel.config or {}, channel.secret, email_message(channel.config or {}, m))
        else:
            await self._post(channel.url or "", m.payload)

    async def _deliver(self, channel: NotificationChannel, messages: list[Message], backlog: list | None | bool = False) -> str | None:
        """Wysyła wiadomości po kolei; zwraca opis błędu albo None. Wynik (i nowe zaległości, jeśli podane) zapisuje przy kanale."""
        error = None
        try:
            for m in messages:
                await self._send_one(channel, m)
        except Exception as exc:  # sieć, TLS, limit czasu, kod błędu usługi, odmowa SMTP
            error = f"{type(exc).__name__}: {exc}"[:500]
            log.warning("Powiadomienie (kanał %s) nie dotarło: %s", channel.id, error)
        values: dict = {}
        if messages:
            values |= {"last_status": "error" if error else "ok", "last_error": error, "last_sent_at": datetime.now(UTC)}
        if backlog is not False:
            values["quiet_backlog"] = backlog
        if values:
            async with Session() as session, session.begin():
                await session.execute(update(NotificationChannel).where(NotificationChannel.id == channel.id).values(**values))
        return error

    def plan(self, channel: NotificationChannel, events: list[AlertEvent], now: datetime) -> tuple[list[Message], list | None | bool]:
        """Co wysłać kanałowi w tym cyklu i jak zmieniają się jego zaległości (False = bez zmian)."""
        now_events, held = split_quiet(channel, select_events(channel, events), now)
        backlog: list | None | bool = False
        messages: list[Message] = []
        stored = list(channel.quiet_backlog or [])
        if held:
            items = stored[:-1] if stored and "skipped" in stored[-1] else stored
            skipped = stored[-1]["skipped"] if stored and "skipped" in stored[-1] else 0
            items += [backlog_item(e) for e in held]
            skipped += max(0, len(items) - BACKLOG_MAX)
            backlog = items[:BACKLOG_MAX] + ([{"skipped": skipped}] if skipped else [])
        elif stored and not in_quiet_hours(channel.quiet_from, channel.quiet_to, now):
            # Koniec ciszy: najpierw podsumowanie tego, co czekało
            skipped = stored[-1]["skipped"] if "skipped" in stored[-1] else 0
            items = [i for i in stored if "skipped" not in i]
            messages.append(digest_message(items, skipped))
            backlog = None
        if now_events:
            messages += [summary_message(now_events)] if len(now_events) >= SUMMARY_FROM else [event_message(e) for e in now_events]
        return messages, backlog

    async def send(self, events: list[AlertEvent]) -> None:
        """Rozsyła zdarzenia ze wszystkich włączonych kanałów i wysyła zaległości po cichych godzinach.
        Wołane w każdym cyklu (także bez zdarzeń). Nigdy nie rzuca wyjątku (nie może zepsuć cyklu kolektora)."""
        try:
            now = self.now_fn()
            async with Session() as session:
                channels = (await session.scalars(select(NotificationChannel).where(NotificationChannel.enabled))).all()
            jobs = []
            for channel in channels:
                if not events and not channel.quiet_backlog:
                    continue
                messages, backlog = self.plan(channel, events, now)
                if messages or backlog is not False:
                    jobs.append(self._deliver(channel, messages, backlog))
            if jobs:
                await asyncio.gather(*jobs)
        except Exception:
            log.exception("Błąd wysyłania powiadomień")

    async def send_test(self, channel: NotificationChannel) -> str | None:
        """Wiadomość próbna z formularza; zwraca opis błędu albo None."""
        return await self._deliver(channel, [probe_message()])
