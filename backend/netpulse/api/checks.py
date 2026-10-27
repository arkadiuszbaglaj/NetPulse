"""Sprawdzanie dostępności (od 0.30.0): ping, HTTP(S), port TCP.

Zmiany może robić tylko administrator, odczyt – każdy zalogowany. Sprawdzenia wykonuje checks_collector.py;
`POST /api/checks/test` wykonuje jedno sprawdzenie od razu, bez zapisu (przycisk „Sprawdź” w formularzu).
Historia (`/api/checks/{id}/metrics`): opóźnienie, utrata pakietów, jitter, dostępność w % i dni do wygaśnięcia
certyfikatu – w kubełkach jak inne wykresy.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Literal
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from sqlalchemy import Integer, cast, delete, func, select, text

from ..checks import run_check, valid_expect
from ..db import Session, engine, has_timescale
from ..db.models import Check, CheckMetric
from .metrics import MinutesQuery, OffsetQuery, _bucket_seconds, window
from .schemas import Point, _check_host
from .security import AdminUser, require_user

router = APIRouter(prefix="/api/checks", tags=["Dostępność"], dependencies=[Depends(require_user)])

MAX_CHECKS = 100
SERIES = ["latency_ms", "loss_percent", "jitter_ms", "availability_percent", "cert_days"]
Kind = Literal["ping", "http", "tcp"]


class CheckIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    kind: Kind
    target: str = Field(min_length=1, max_length=512)
    port: int | None = Field(None, ge=1, le=65535)
    interval_s: int = Field(60, ge=10, le=3600)
    timeout_s: float = Field(5.0, ge=1, le=30)
    enabled: bool = True
    expect_status: str | None = Field(None, max_length=32)
    keyword: str | None = Field(None, max_length=255)
    verify_tls: bool = True

    @field_validator("name", "target")
    @classmethod
    def _strip(cls, v: str) -> str:
        return v.strip()

    @field_validator("expect_status", "keyword")
    @classmethod
    def _empty(cls, v: str | None) -> str | None:
        v = v.strip() if v else v
        return v or None

    @model_validator(mode="after")
    def _consistent(self) -> CheckIn:
        if self.kind == "http":
            parts = urlsplit(self.target)
            if parts.scheme not in ("http", "https") or not parts.hostname:
                raise ValueError("Podaj adres zaczynający się od http:// albo https://")
            if self.expect_status and not valid_expect(self.expect_status):
                raise ValueError("Oczekiwany kod: np. 200, 200-399, 2xx albo lista po przecinku")
            self.port = None
        else:
            self.target = _check_host(self.target)
            self.expect_status = self.keyword = None
            if self.kind == "tcp" and self.port is None:
                raise ValueError("Podaj port TCP")
            if self.kind == "ping":
                self.port = None
        if self.timeout_s >= self.interval_s:
            raise ValueError("Limit czasu musi być krótszy niż odstęp między sprawdzeniami")
        return self


class CheckOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    kind: str
    target: str
    port: int | None
    interval_s: int
    timeout_s: float
    enabled: bool
    expect_status: str | None
    keyword: str | None
    verify_tls: bool
    status: str
    status_since: datetime | None
    last_checked_at: datetime | None
    last_ok_at: datetime | None
    last_error: str | None
    last_latency_ms: float | None
    created_at: datetime
    # z historii: dostępność z 24 h i ostatni wynik
    availability_24h: float | None = None
    loss_percent: float | None = None
    jitter_ms: float | None = None
    status_code: int | None = None
    cert_days: float | None = None


class TestOut(BaseModel):
    up: bool
    latency_ms: float | None
    loss_percent: float | None
    jitter_ms: float | None
    status_code: int | None
    cert_days: float | None
    error: str | None


async def _stats(session, ids: list[int]) -> tuple[dict[int, float], dict[int, CheckMetric]]:
    if not ids:
        return {}, {}
    since = datetime.now(UTC) - timedelta(hours=24)
    avail = dict(
        (
            await session.execute(
                select(CheckMetric.check_id, func.avg(cast(CheckMetric.up, Integer)) * 100.0)
                .where(CheckMetric.check_id.in_(ids), CheckMetric.time >= since)
                .group_by(CheckMetric.check_id)
            )
        ).all()
    )
    latest = {
        m.check_id: m
        for m in (
            await session.scalars(
                select(CheckMetric)
                .distinct(CheckMetric.check_id)
                .where(CheckMetric.check_id.in_(ids), CheckMetric.time >= since)
                .order_by(CheckMetric.check_id, CheckMetric.time.desc())
            )
        ).all()
    }
    return {k: round(float(v), 2) for k, v in avail.items()}, latest


def _out(c: Check, avail: dict[int, float], latest: dict[int, CheckMetric]) -> CheckOut:
    out = CheckOut.model_validate(c)
    out.availability_24h = avail.get(c.id)
    m = latest.get(c.id)
    if m is not None:
        out.loss_percent, out.jitter_ms, out.status_code, out.cert_days = m.loss_percent, m.jitter_ms, m.status_code, m.cert_days
    return out


async def list_checks() -> list[CheckOut]:
    async with Session() as session:
        rows = (await session.scalars(select(Check).order_by(Check.name, Check.id))).all()
        avail, latest = await _stats(session, [c.id for c in rows])
    return [_out(c, avail, latest) for c in rows]


@router.get("", response_model=list[CheckOut])
async def get_checks():
    return await list_checks()


@router.post("", response_model=CheckOut, status_code=201)
async def create_check(body: CheckIn, _: AdminUser):
    async with Session() as session, session.begin():
        if await session.scalar(select(func.count()).select_from(Check)) >= MAX_CHECKS:
            raise HTTPException(409, f"Można mieć najwyżej {MAX_CHECKS} sprawdzeń")
        row = Check(**body.model_dump(), status="unknown")
        session.add(row)
        await session.flush()
        await session.refresh(row)
    return _out(row, {}, {})


@router.put("/{check_id}", response_model=CheckOut)
async def update_check(check_id: int, body: CheckIn, _: AdminUser):
    async with Session() as session, session.begin():
        row = await session.get(Check, check_id, with_for_update=True)
        if row is None:
            raise HTTPException(404, "Nie ma takiego sprawdzenia")
        changed_target = (row.kind, row.target, row.port) != (body.kind, body.target, body.port)
        for key, value in body.model_dump().items():
            setattr(row, key, value)
        if changed_target:  # inny cel – stary stan i błąd już nie pasują
            row.status, row.status_since, row.last_error, row.last_latency_ms = "unknown", None, None, None
        await session.flush()
        await session.refresh(row)
        avail, latest = await _stats(session, [row.id])
    return _out(row, avail, latest)


@router.delete("/{check_id}", status_code=204)
async def delete_check(check_id: int, _: AdminUser):
    async with Session() as session, session.begin():
        if (await session.execute(delete(Check).where(Check.id == check_id))).rowcount == 0:
            raise HTTPException(404, "Nie ma takiego sprawdzenia")


@router.post("/test", response_model=TestOut)
async def test_check(body: CheckIn, _: AdminUser):
    r = await run_check(body.kind, body.target, port=body.port, timeout=body.timeout_s, expect=body.expect_status,
                        keyword=body.keyword, verify_tls=body.verify_tls)  # fmt: skip
    return TestOut(**r.__dict__)


async def check_series(check_id: int, minutes: int, offset: int = 0) -> list[Point]:
    since, until = window(minutes, offset)
    async with engine.connect() as conn:
        timescale = await has_timescale(conn)
    async with Session() as session:
        if await session.get(Check, check_id) is None:
            raise HTTPException(404, "Nie ma takiego sprawdzenia")
        m = CheckMetric
        values = [
            func.avg(m.latency_ms), func.avg(m.loss_percent), func.avg(m.jitter_ms),
            func.avg(cast(m.up, Integer)) * 100.0, func.min(m.cert_days),
        ]  # fmt: skip
        bucket = (
            func.time_bucket(text(f"INTERVAL '{_bucket_seconds(minutes)} seconds'"), m.time)
            if timescale
            else func.date_bin(text(f"INTERVAL '{_bucket_seconds(minutes)} seconds'"), m.time, text("TIMESTAMPTZ '2000-01-01'"))
        )
        rows = (
            await session.execute(
                select(bucket.label("bucket"), *values)
                .where(m.check_id == check_id, m.time >= since, m.time < until)
                .group_by("bucket")
                .order_by("bucket")
            )
        ).all()
    return [
        Point(time=r[0], values={c: (round(float(v), 2) if v is not None else None) for c, v in zip(SERIES, r[1:], strict=True)})
        for r in rows
    ]


@router.get("/{check_id}/metrics", response_model=list[Point])
async def check_metrics(check_id: int, minutes: int = MinutesQuery, offset: int = OffsetQuery):
    return await check_series(check_id, minutes, offset)
