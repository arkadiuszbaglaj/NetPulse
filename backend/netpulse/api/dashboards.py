"""Pulpity zapisane na koncie: układ widgetów, wiele pulpitów (jeden domyślny pod „/”) i udostępnianie publiczne.

`/api/dashboards/default` – pulpit domyślny (brak zapisanego = panel używa układu domyślnego, nic nie jest
zapisywane z góry). Pozostałe pulpity mają własne id. Pulpit publiczny dostaje link `/p/<token>`; dane dla niego
wydaje osobne API tylko do odczytu (api/public.py)."""

from __future__ import annotations

import io
import re
from datetime import UTC, datetime

import segno
from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, Field, ValidationError, field_validator
from sqlalchemy import func, select, text, update

from ..auth import hash_password, hash_token, new_token
from ..db import Session
from ..db.models import Dashboard
from .layout_schemas import SCHEMA_VERSION, DashboardLayout, PublicOptions, Strict
from .security import CurrentUser, require_user

router = APIRouter(prefix="/api/dashboards", tags=["pulpit"], dependencies=[Depends(require_user)])

# Blokada na użytkownika, żeby dwa równoczesne pierwsze zapisy nie utworzyły dwóch pulpitów domyślnych
_LOCK_BASE = 0x4E50 << 32
MAX_DASHBOARDS = 20
_ORIGIN_RE = re.compile(r"^https?://[A-Za-z0-9.\-\[\]:]+$")
OriginQuery = Query(max_length=255, description="adres panelu, np. http://192.168.1.10:8080")


class DashboardOut(BaseModel):
    layout: DashboardLayout | None
    updated_at: datetime | None


class PublicInfo(BaseModel):
    token: str
    expires_at: datetime | None
    expired: bool
    has_pin: bool
    options: PublicOptions


class DashboardInfo(BaseModel):
    id: int
    name: str
    is_default: bool
    widgets: int
    updated_at: datetime
    public: PublicInfo | None  # None = pulpit prywatny


class DashboardFull(DashboardInfo):
    layout: DashboardLayout | None


def _strip_name(v: str | None) -> str | None:
    if v is None:
        return None
    v = v.strip()
    if not v:
        raise ValueError("Podaj nazwę pulpitu")
    return v


class DashboardCreate(Strict):
    name: str = Field(min_length=1, max_length=80)
    layout: DashboardLayout
    make_default: bool = False

    @field_validator("name")
    @classmethod
    def _name(cls, v: str) -> str | None:
        return _strip_name(v)


class DashboardPatch(Strict):
    name: str | None = Field(None, min_length=1, max_length=80)
    layout: DashboardLayout | None = None

    @field_validator("name")
    @classmethod
    def _name(cls, v: str | None) -> str | None:
        return _strip_name(v)


class PublicIn(Strict):
    enabled: bool
    expires_at: datetime | None = None
    pin: str | None = Field(None, pattern=r"^\d{4,12}$")  # nowy PIN; None = bez zmian
    clear_pin: bool = False
    options: PublicOptions = PublicOptions()


def _parse(raw: dict | None) -> DashboardLayout | None:
    """Zapisany układ, który przestał pasować do schematu (np. po zmianie wersji), traktujemy jak brak."""
    if not raw:
        return None
    try:
        return DashboardLayout.model_validate(raw)
    except ValidationError:
        return None


def public_options(row: Dashboard) -> PublicOptions:
    try:
        return PublicOptions.model_validate(row.public_options or {})
    except ValidationError:
        return PublicOptions()


def _info(row: Dashboard) -> DashboardInfo:
    layout = _parse(row.layout)
    public = None
    if row.public_token_hash and row.public_token:
        now = datetime.now(UTC)
        public = PublicInfo(
            token=row.public_token,
            expires_at=row.public_expires_at,
            expired=row.public_expires_at is not None and row.public_expires_at <= now,
            has_pin=row.public_pin_hash is not None,
            options=public_options(row),
        )
    return DashboardInfo(
        id=row.id,
        name=row.name,
        is_default=row.is_default,
        widgets=len(layout.widgets) if layout else 0,
        updated_at=row.updated_at,
        public=public,
    )


def _full(row: Dashboard) -> DashboardFull:
    return DashboardFull(**_info(row).model_dump(), layout=_parse(row.layout))


async def _default_row(session, user_id: int) -> Dashboard | None:
    return await session.scalar(select(Dashboard).where(Dashboard.owner_id == user_id, Dashboard.is_default.is_(True)))


async def _own(session, user_id: int, dashboard_id: int) -> Dashboard:
    row = await session.get(Dashboard, dashboard_id)
    if row is None or row.owner_id != user_id:
        raise HTTPException(404, "Nie ma takiego pulpitu")
    return row


async def _lock(session, user_id: int) -> None:
    await session.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": _LOCK_BASE + user_id})


# --- pulpit domyślny (pod „/”) -------------------------------------------------------


@router.get("/default", response_model=DashboardOut)
async def get_default(user: CurrentUser):
    async with Session() as session:
        row = await _default_row(session, user.id)
    return DashboardOut(layout=_parse(row.layout) if row else None, updated_at=row.updated_at if row else None)


@router.put("/default", response_model=DashboardOut)
async def put_default(layout: DashboardLayout, user: CurrentUser):
    data = layout.model_dump(mode="json")
    now = datetime.now(UTC)
    async with Session() as session, session.begin():
        await _lock(session, user.id)
        row = await _default_row(session, user.id)
        if row is None:
            row = Dashboard(owner_id=user.id, is_default=True, schema_version=SCHEMA_VERSION, layout=data, updated_at=now)
            session.add(row)
        else:
            row.layout, row.schema_version, row.updated_at = data, SCHEMA_VERSION, now
    return DashboardOut(layout=layout, updated_at=now)


@router.delete("/default", status_code=204)
async def reset_default(user: CurrentUser):
    """Przywraca układ domyślny. Pulpit udostępniony publicznie nie znika – przestaje tylko być domyślnym."""
    async with Session() as session, session.begin():
        row = await _default_row(session, user.id)
        if row is None:
            return
        if row.public_token_hash:
            row.is_default = False
        else:
            await session.delete(row)


# --- wiele pulpitów ------------------------------------------------------------------


@router.get("", response_model=list[DashboardInfo])
async def list_dashboards(user: CurrentUser):
    async with Session() as session:
        rows = (await session.scalars(select(Dashboard).where(Dashboard.owner_id == user.id).order_by(Dashboard.id))).all()
    return [_info(r) for r in rows]


@router.post("", response_model=DashboardFull, status_code=201)
async def create_dashboard(body: DashboardCreate, user: CurrentUser):
    now = datetime.now(UTC)
    async with Session() as session, session.begin():
        await _lock(session, user.id)
        count = await session.scalar(select(func.count()).select_from(Dashboard).where(Dashboard.owner_id == user.id))
        if count >= MAX_DASHBOARDS:
            raise HTTPException(409, f"Można mieć najwyżej {MAX_DASHBOARDS} pulpitów")
        if body.make_default:
            await session.execute(update(Dashboard).where(Dashboard.owner_id == user.id).values(is_default=False))
        row = Dashboard(
            owner_id=user.id,
            name=body.name,
            is_default=body.make_default,
            schema_version=SCHEMA_VERSION,
            layout=body.layout.model_dump(mode="json"),
            updated_at=now,
        )
        session.add(row)
        await session.flush()
        await session.refresh(row)
    return _full(row)


@router.get("/{dashboard_id}", response_model=DashboardFull)
async def get_dashboard(dashboard_id: int, user: CurrentUser):
    async with Session() as session:
        return _full(await _own(session, user.id, dashboard_id))


@router.patch("/{dashboard_id}", response_model=DashboardFull)
async def patch_dashboard(dashboard_id: int, body: DashboardPatch, user: CurrentUser):
    async with Session() as session, session.begin():
        row = await _own(session, user.id, dashboard_id)
        if body.name is not None:
            row.name = body.name
        if body.layout is not None:
            row.layout, row.schema_version = body.layout.model_dump(mode="json"), SCHEMA_VERSION
        row.updated_at = datetime.now(UTC)
    return _full(row)


@router.delete("/{dashboard_id}", status_code=204)
async def delete_dashboard(dashboard_id: int, user: CurrentUser):
    """Usuwa pulpit; jego publiczny link przestaje działać. Po usunięciu domyślnego „/” pokazuje układ domyślny."""
    async with Session() as session, session.begin():
        await session.delete(await _own(session, user.id, dashboard_id))


@router.post("/{dashboard_id}/default", response_model=DashboardInfo)
async def make_default(dashboard_id: int, user: CurrentUser):
    async with Session() as session, session.begin():
        await _lock(session, user.id)
        row = await _own(session, user.id, dashboard_id)
        await session.execute(update(Dashboard).where(Dashboard.owner_id == user.id, Dashboard.id != row.id).values(is_default=False))
        row.is_default = True
    return _info(row)


# --- udostępnianie publiczne ---------------------------------------------------------


def _new_token(row: Dashboard) -> None:
    token = new_token()
    row.public_token, row.public_token_hash = token, hash_token(token)


@router.put("/{dashboard_id}/public", response_model=DashboardInfo)
async def set_public(dashboard_id: int, body: PublicIn, user: CurrentUser):
    """Włącza albo wyłącza publiczny link. Wyłączenie unieważnia link (ponowne włączenie da nowy)."""
    if body.enabled and body.expires_at is not None and body.expires_at <= datetime.now(UTC):
        raise HTTPException(422, "Data wygaśnięcia musi być w przyszłości")
    async with Session() as session, session.begin():
        row = await _own(session, user.id, dashboard_id)
        if not body.enabled:
            row.public_token = row.public_token_hash = row.public_pin_hash = row.public_expires_at = None
            return _info(row)
        if _parse(row.layout) is None:
            raise HTTPException(409, "Najpierw dodaj widgety do pulpitu")
        if not row.public_token_hash:
            _new_token(row)
        row.public_expires_at = body.expires_at
        row.public_options = body.options.model_dump(mode="json")
        if body.clear_pin:
            row.public_pin_hash = None
        elif body.pin:
            row.public_pin_hash = hash_password(body.pin)
    return _info(row)


@router.post("/{dashboard_id}/public/rotate", response_model=DashboardInfo)
async def rotate_public(dashboard_id: int, user: CurrentUser):
    """Nowy link – stary od razu przestaje działać (np. gdy trafił do niewłaściwej osoby)."""
    async with Session() as session, session.begin():
        row = await _own(session, user.id, dashboard_id)
        if not row.public_token_hash:
            raise HTTPException(409, "Ten pulpit nie jest udostępniony")
        _new_token(row)
    return _info(row)


@router.get("/{dashboard_id}/public/qr.svg")
async def public_qr(dashboard_id: int, user: CurrentUser, origin: str = OriginQuery):
    """Kod QR z linkiem do pulpitu publicznego (do zeskanowania telefonem albo wydruku przy wyświetlaczu)."""
    if not _ORIGIN_RE.match(origin):
        raise HTTPException(422, "Nieprawidłowy adres panelu")
    async with Session() as session:
        row = await _own(session, user.id, dashboard_id)
    if not row.public_token:
        raise HTTPException(409, "Ten pulpit nie jest udostępniony")
    out = io.BytesIO()
    segno.make(f"{origin}/p/{row.public_token}", error="m").save(out, kind="svg", scale=6, border=2, xmldecl=False)
    return Response(out.getvalue(), media_type="image/svg+xml", headers={"Cache-Control": "no-store"})

