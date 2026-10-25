"""Kanały powiadomień o alertach (webhook, ntfy, e-mail): zarządzanie i wiadomość próbna. Zarządzać może tylko administrator.

Sekrety (adres webhooka i tematu ntfy, token ntfy, hasło SMTP) nie wracają z API; ich brak w zmianie znaczy „bez zmian”."""

from __future__ import annotations

import re
from datetime import datetime
from typing import Annotated, Literal
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import select

from ..config import settings
from ..db import Session
from ..db.models import NotificationChannel
from ..notifications import Notifier, mask_url
from .security import AdminUser, require_user

router = APIRouter(prefix="/api/notification-channels", tags=["powiadomienia"], dependencies=[Depends(require_user)])

Severity = Literal["info", "warning", "critical"]
Kind = Literal["webhook", "ntfy", "email"]
HHMM = re.compile(r"([01]\d|2[0-3]):[0-5]\d")
EMAIL = re.compile(r"[^@\s,]+@[^@\s,]+")


def _check_url(value: str) -> str:
    value = value.strip()
    parts = urlsplit(value)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        raise ValueError("Adres musi zaczynać się od http:// albo https://")
    return value


def _check_hhmm(value: str | None) -> str | None:
    if value in (None, ""):
        return None
    if not HHMM.fullmatch(value):
        raise ValueError("Godzina w formacie GG:MM, np. 22:00")
    return value


def _check_email(value: str) -> str:
    value = value.strip()
    if not EMAIL.fullmatch(value):
        raise ValueError(f"Niepoprawny adres e-mail: {value}")
    return value


class EmailConfig(BaseModel):
    """Serwer SMTP. Hasło jest osobno (pole `secret`)."""

    host: str = Field(min_length=1, max_length=255)
    port: int = Field(587, ge=1, le=65535)
    security: Literal["starttls", "ssl", "none"] = "starttls"
    username: Annotated[str, Field(max_length=255)] | None = None
    sender: Annotated[str, Field(max_length=255)] | None = None
    recipients: list[str] = Field(min_length=1, max_length=10)

    @field_validator("host")
    @classmethod
    def _host(cls, v: str) -> str:
        return v.strip()

    @field_validator("username", "sender")
    @classmethod
    def _blank(cls, v: str | None) -> str | None:
        return v.strip() or None if v is not None else None

    @field_validator("sender")
    @classmethod
    def _sender(cls, v: str | None) -> str | None:
        return _check_email(v) if v else None

    @field_validator("recipients")
    @classmethod
    def _recipients(cls, v: list[str]) -> list[str]:
        return [_check_email(r) for r in v]


class QuietHours(BaseModel):
    quiet_from: str | None = None
    quiet_to: str | None = None
    quiet_critical: bool = True

    @field_validator("quiet_from", "quiet_to")
    @classmethod
    def _hhmm(cls, v: str | None) -> str | None:
        return _check_hhmm(v)


class ChannelCreate(QuietHours):
    name: str = Field(min_length=1, max_length=128)
    kind: Kind = "webhook"
    enabled: bool = True
    min_severity: Severity = "warning"
    notify_resolved: bool = True
    url: str | None = Field(None, min_length=8, max_length=1024)
    secret: str | None = Field(None, max_length=512)
    email: EmailConfig | None = None

    @field_validator("url")
    @classmethod
    def _url(cls, v: str | None) -> str | None:
        return _check_url(v) if v is not None else None

    @model_validator(mode="after")
    def _by_kind(self) -> ChannelCreate:
        if self.kind == "email":
            if self.email is None:
                raise ValueError("Podaj serwer SMTP i adresata")
            self.url = None
        else:
            if not self.url:
                raise ValueError("Podaj adres" + (" tematu ntfy" if self.kind == "ntfy" else " webhooka"))
            if self.kind == "ntfy" and not urlsplit(self.url).path.strip("/"):
                raise ValueError("Adres tematu ntfy musi mieć nazwę tematu, np. https://ntfy.sh/moj-temat")
            if self.kind == "webhook":
                self.secret = None
            self.email = None
        self.secret = self.secret or None
        return self


class ChannelUpdate(BaseModel):
    """Pola pominięte zostają bez zmian. Sekrety nigdy nie wracają, więc ich brak znaczy „bez zmian”;
    pusty `secret` usuwa token ntfy albo hasło SMTP."""

    name: str | None = Field(None, min_length=1, max_length=128)
    enabled: bool | None = None
    min_severity: Severity | None = None
    notify_resolved: bool | None = None
    url: str | None = Field(None, min_length=8, max_length=1024)
    secret: str | None = Field(None, max_length=512)
    email: EmailConfig | None = None
    quiet_from: str | None = None
    quiet_to: str | None = None
    quiet_critical: bool | None = None

    @field_validator("url")
    @classmethod
    def _url(cls, v: str | None) -> str | None:
        return _check_url(v) if v is not None else None

    @field_validator("quiet_from", "quiet_to")
    @classmethod
    def _hhmm(cls, v: str | None) -> str | None:
        return _check_hhmm(v)


class EmailOut(BaseModel):
    host: str
    port: int
    security: str
    username: str | None
    sender: str | None
    recipients: list[str]


class ChannelOut(BaseModel):
    id: int
    name: str
    kind: str
    url_hint: str  # sam host, bez ścieżki i tokenów (e-mail: serwer SMTP)
    has_secret: bool
    email: EmailOut | None
    enabled: bool
    min_severity: str
    notify_resolved: bool
    quiet_from: str | None
    quiet_to: str | None
    quiet_critical: bool
    quiet_pending: int  # alerty czekające na koniec cichych godzin
    timezone: str  # strefa, w której liczą się ciche godziny
    last_status: str | None
    last_error: str | None
    last_sent_at: datetime | None
    created_at: datetime


class TestResult(BaseModel):
    ok: bool
    error: str | None = None


def _out(c: NotificationChannel) -> ChannelOut:
    email = EmailOut.model_validate(c.config) if c.kind == "email" and c.config else None
    pending = sum(i.get("skipped", 1) for i in c.quiet_backlog or [])
    return ChannelOut(
        id=c.id,
        name=c.name,
        kind=c.kind,
        url_hint=f"{email.host}:{email.port}" if email else mask_url(c.url),
        has_secret=bool(c.secret),
        email=email,
        enabled=c.enabled,
        min_severity=c.min_severity,
        notify_resolved=c.notify_resolved,
        quiet_from=c.quiet_from,
        quiet_to=c.quiet_to,
        quiet_critical=c.quiet_critical,
        quiet_pending=pending,
        timezone=settings.timezone,
        last_status=c.last_status,
        last_error=c.last_error,
        last_sent_at=c.last_sent_at,
        created_at=c.created_at,
    )


async def _get(session, channel_id: int) -> NotificationChannel:
    channel = await session.get(NotificationChannel, channel_id)
    if channel is None:
        raise HTTPException(404, "Nie ma takiego kanału")
    return channel


@router.get("", response_model=list[ChannelOut])
async def list_channels():
    async with Session() as session:
        return [_out(c) for c in (await session.scalars(select(NotificationChannel).order_by(NotificationChannel.id))).all()]


@router.post("", response_model=ChannelOut, status_code=201)
async def create_channel(body: ChannelCreate, _: AdminUser):
    data = body.model_dump(exclude={"email"})
    data["config"] = body.email.model_dump() if body.email else {}
    async with Session() as session, session.begin():
        channel = NotificationChannel(**data)
        session.add(channel)
        await session.flush()
        await session.refresh(channel)
        return _out(channel)


@router.patch("/{channel_id}", response_model=ChannelOut)
async def update_channel(channel_id: int, body: ChannelUpdate, _: AdminUser):
    changes = body.model_dump(exclude_unset=True)
    for name in ("name", "enabled", "min_severity", "notify_resolved", "url", "email", "quiet_critical"):
        if name in changes and changes[name] is None:
            raise HTTPException(422, f"Pole {name} nie może być puste")
    async with Session() as session, session.begin():
        channel = await _get(session, channel_id)
        if "email" in changes:
            if channel.kind != "email":
                raise HTTPException(422, "Serwer SMTP ustawia się tylko w kanale e-mail")
            channel.config = body.email.model_dump()
            changes.pop("email")
        if "url" in changes and channel.kind == "email":
            raise HTTPException(422, "Kanał e-mail nie ma adresu URL")
        if "url" in changes and channel.kind == "ntfy" and not urlsplit(changes["url"]).path.strip("/"):
            raise HTTPException(422, "Adres tematu ntfy musi mieć nazwę tematu, np. https://ntfy.sh/moj-temat")
        if "secret" in changes:
            if channel.kind == "webhook":
                raise HTTPException(422, "Webhook nie ma osobnego tokenu – sekret jest w adresie")
            changes["secret"] = changes["secret"] or None
        # Wyłączenie cichych godzin nie gubi zaległości: kolektor wyśle je w najbliższym cyklu
        for field, value in changes.items():
            setattr(channel, field, value)
        return _out(channel)


@router.delete("/{channel_id}", status_code=204)
async def delete_channel(channel_id: int, _: AdminUser):
    async with Session() as session, session.begin():
        await session.delete(await _get(session, channel_id))


@router.post("/{channel_id}/test", response_model=TestResult)
async def test_channel(channel_id: int, _: AdminUser):
    """Wysyła wiadomość próbną, żeby sprawdzić ustawienia kanału. Wynik zapisuje przy kanale."""
    async with Session() as session:
        channel = await _get(session, channel_id)
        session.expunge(channel)
    error = await Notifier().send_test(channel)
    return TestResult(ok=error is None, error=error)
