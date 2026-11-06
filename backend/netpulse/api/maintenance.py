"""Okna serwisowe (od 0.60.0): lista, dodawanie, zmiana, usuwanie. Logika: maintenance.py."""

from __future__ import annotations

import re
from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from sqlalchemy import delete, func, select

from .. import maintenance
from ..db import Session
from ..db.models import Device, MaintenanceWindow
from .security import OperatorUser, require_user

router = APIRouter(prefix="/api/maintenance", tags=["okna serwisowe"], dependencies=[Depends(require_user)])

MAX_WINDOWS = 100
_HHMM = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


class WindowIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    enabled: bool = True
    # Puste = wszystkie urządzenia, sprawdzenia dostępności i alerty bez urządzenia
    device_ids: list[int] = Field(default_factory=list, max_length=500)
    kind: Literal["once", "weekly"]
    starts_at: datetime | None = None
    ends_at: datetime | None = None
    days: list[int] = Field(default_factory=list, max_length=7)
    time_from: str | None = None
    duration_min: int | None = Field(None, ge=1, le=maintenance.MAX_WEEKLY_MIN)
    note: str | None = Field(None, max_length=1000)

    @field_validator("name", "note")
    @classmethod
    def _strip(cls, v: str | None) -> str | None:
        return v.strip() if isinstance(v, str) else v

    @model_validator(mode="after")
    def _schedule(self) -> WindowIn:
        if not self.name:
            raise ValueError("Podaj nazwę okna")
        self.device_ids = sorted(set(self.device_ids))
        if self.kind == "once":
            if self.starts_at is None or self.ends_at is None:
                raise ValueError("Podaj początek i koniec okna")
            if self.starts_at.tzinfo is None or self.ends_at.tzinfo is None:
                raise ValueError("Czas musi mieć strefę czasową")
            if self.ends_at <= self.starts_at:
                raise ValueError("Koniec okna musi być po początku")
            if self.ends_at - self.starts_at > maintenance.MAX_ONCE:
                raise ValueError("Okno jednorazowe może trwać najwyżej 31 dni")
            self.days, self.time_from, self.duration_min = [], None, None
        else:
            if not self.days or any(d < 0 or d > 6 for d in self.days):
                raise ValueError("Wybierz dni tygodnia")
            if not self.time_from or not _HHMM.match(self.time_from):
                raise ValueError("Godzina początku w formacie GG:MM")
            if not self.duration_min:
                raise ValueError("Podaj czas trwania okna")
            self.days = sorted(set(self.days))
            self.starts_at = self.ends_at = None
        return self


class WindowOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    enabled: bool
    device_ids: list[int]
    kind: str
    starts_at: datetime | None
    ends_at: datetime | None
    days: list[int]
    time_from: str | None
    duration_min: int | None
    note: str | None
    created_at: datetime
    # Teraz trwa (do kiedy) i najbliższy początek – liczone przy odczycie
    active: bool = False
    active_until: datetime | None = None
    next_start: datetime | None = None

    @field_validator("device_ids", "days", mode="before")
    @classmethod
    def _list(cls, v):
        return v or []


def _out(row: MaintenanceWindow, now: datetime) -> WindowOut:
    out = WindowOut.model_validate(row)
    w = maintenance.from_row(row)
    until = w.active_until(now) if row.enabled else None
    out.active, out.active_until = until is not None, until
    out.next_start = w.next_start(now) if row.enabled else None
    return out


async def _check_devices(session, ids: list[int]) -> None:
    if not ids:
        return
    found = set((await session.scalars(select(Device.id).where(Device.id.in_(ids)))).all())
    if missing := sorted(set(ids) - found):
        raise HTTPException(422, f"Nie ma urządzeń: {', '.join(map(str, missing))}")


@router.get("", response_model=list[WindowOut])
async def list_windows():
    now = datetime.now(UTC)
    async with Session() as session:
        rows = (await session.scalars(select(MaintenanceWindow).order_by(MaintenanceWindow.name, MaintenanceWindow.id))).all()
    return [_out(r, now) for r in rows]


@router.post("", response_model=WindowOut, status_code=201)
async def create_window(body: WindowIn, _: OperatorUser):
    async with Session() as session, session.begin():
        if await session.scalar(select(func.count()).select_from(MaintenanceWindow)) >= MAX_WINDOWS:
            raise HTTPException(409, f"Można mieć najwyżej {MAX_WINDOWS} okien serwisowych")
        await _check_devices(session, body.device_ids)
        row = MaintenanceWindow(**body.model_dump())
        session.add(row)
        await session.flush()
        await session.refresh(row)
    return _out(row, datetime.now(UTC))


@router.put("/{window_id}", response_model=WindowOut)
async def update_window(window_id: int, body: WindowIn, _: OperatorUser):
    async with Session() as session, session.begin():
        row = await session.get(MaintenanceWindow, window_id, with_for_update=True)
        if row is None:
            raise HTTPException(404, "Nie ma takiego okna serwisowego")
        await _check_devices(session, body.device_ids)
        for key, value in body.model_dump().items():
            setattr(row, key, value)
        await session.flush()
        await session.refresh(row)
    return _out(row, datetime.now(UTC))


@router.delete("/{window_id}", status_code=204)
async def delete_window(window_id: int, _: OperatorUser):
    async with Session() as session, session.begin():
        if (await session.execute(delete(MaintenanceWindow).where(MaintenanceWindow.id == window_id))).rowcount == 0:
            raise HTTPException(404, "Nie ma takiego okna serwisowego")


async def active_device_ids(session, now: datetime | None = None) -> tuple[bool, set[int]]:
    """(okno na wszystko trwa, urządzenia w trwających oknach) – znacznik „prace serwisowe” w liście urządzeń."""
    windows = maintenance.active(await maintenance.load(session), now or datetime.now(UTC))
    return any(w.device_ids is None for w in windows), {i for w in windows if w.device_ids for i in w.device_ids}
