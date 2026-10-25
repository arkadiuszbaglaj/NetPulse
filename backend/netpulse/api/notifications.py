"""Kanały powiadomień o alertach (webhook): zarządzanie i wiadomość próbna. Zarządzać może tylko administrator."""

from __future__ import annotations

from datetime import datetime
from typing import Literal
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select

from ..db import Session
from ..db.models import NotificationChannel
from ..notifications import Notifier, mask_url
from .security import AdminUser, require_user

router = APIRouter(prefix="/api/notification-channels", tags=["powiadomienia"], dependencies=[Depends(require_user)])

Severity = Literal["info", "warning", "critical"]


def _check_url(value: str) -> str:
    value = value.strip()
    parts = urlsplit(value)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        raise ValueError("Adres webhooka musi zaczynać się od http:// albo https://")
    return value


class ChannelBase(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    enabled: bool = True
    min_severity: Severity = "warning"
    notify_resolved: bool = True


class ChannelCreate(ChannelBase):
    url: str = Field(min_length=8, max_length=1024)

    @field_validator("url")
    @classmethod
    def _url(cls, v: str) -> str:
        return _check_url(v)


class ChannelUpdate(BaseModel):
    """Pola pominięte zostają bez zmian; adres (zawiera sekret) nigdy nie wraca, więc jego brak znaczy „bez zmian”."""

    name: str | None = Field(None, min_length=1, max_length=128)
    enabled: bool | None = None
    min_severity: Severity | None = None
    notify_resolved: bool | None = None
    url: str | None = Field(None, min_length=8, max_length=1024)

    @field_validator("url")
    @classmethod
    def _url(cls, v: str | None) -> str | None:
        return _check_url(v) if v is not None else None


class ChannelOut(BaseModel):
    id: int
    name: str
    kind: str
    url_hint: str  # sam host, bez ścieżki i tokenów
    enabled: bool
    min_severity: str
    notify_resolved: bool
    last_status: str | None
    last_error: str | None
    last_sent_at: datetime | None
    created_at: datetime


class TestResult(BaseModel):
    ok: bool
    error: str | None = None


def _out(c: NotificationChannel) -> ChannelOut:
    return ChannelOut(
        id=c.id,
        name=c.name,
        kind=c.kind,
        url_hint=mask_url(c.url),
        enabled=c.enabled,
        min_severity=c.min_severity,
        notify_resolved=c.notify_resolved,
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
    async with Session() as session, session.begin():
        channel = NotificationChannel(**body.model_dump())
        session.add(channel)
        await session.flush()
        await session.refresh(channel)
        return _out(channel)


@router.patch("/{channel_id}", response_model=ChannelOut)
async def update_channel(channel_id: int, body: ChannelUpdate, _: AdminUser):
    changes = body.model_dump(exclude_unset=True)
    for field, value in changes.items():
        if value is None:
            raise HTTPException(422, f"Pole {field} nie może być puste")
    async with Session() as session, session.begin():
        channel = await _get(session, channel_id)
        for field, value in changes.items():
            setattr(channel, field, value)
        return _out(channel)


@router.delete("/{channel_id}", status_code=204)
async def delete_channel(channel_id: int, _: AdminUser):
    async with Session() as session, session.begin():
        await session.delete(await _get(session, channel_id))


@router.post("/{channel_id}/test", response_model=TestResult)
async def test_channel(channel_id: int, _: AdminUser):
    """Wysyła wiadomość próbną, żeby sprawdzić adres. Wynik zapisuje przy kanale."""
    async with Session() as session:
        channel = await _get(session, channel_id)
        url = channel.url
    error = await Notifier().send_test(channel_id, url)
    return TestResult(ok=error is None, error=error)
