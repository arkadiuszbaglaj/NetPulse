"""Konta panelu i dziennik audytu (od 0.61.0) – tylko administrator.

Konta: lista, dodanie (login, hasło, rola), zmiana roli albo hasła, usunięcie. Ostatniego administratora nie da się
usunąć ani zdegradować, a własnego konta nie da się usunąć (zostałby panel bez nikogo, kto nim zarządza).
Zmiana hasła albo roli i wyłączenie logowania dwuskładnikowego (`reset_totp`) wylogowują to konto ze wszystkich sesji.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import delete, func, or_, select

from ..auth import hash_password_async, password_error, username_error
from ..db import Session
from ..db.models import AuditEntry, AuthSession, User
from .auth_routes import clear_totp
from .schemas import UserOut
from .security import AdminUser, forget_sessions, require_admin

router = APIRouter(prefix="/api", tags=["konta"], dependencies=[Depends(require_admin)])

Role = Literal["admin", "operator", "viewer"]
MAX_USERS = 50


class UserCreate(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=256)
    role: Role = "viewer"


class UserUpdate(BaseModel):
    role: Role | None = None
    password: str | None = Field(None, min_length=1, max_length=256)
    # Wyłącza logowanie dwuskładnikowe (zgubiony telefon i kody zapasowe)
    reset_totp: bool = False


class AuditOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    time: datetime
    user_id: int | None
    username: str | None
    ip: str | None
    action: str
    target: str | None
    status: int | None
    detail: str | None


class AuditPage(BaseModel):
    items: list[AuditOut]
    total: int


async def _admins(session) -> int:
    return await session.scalar(select(func.count()).select_from(User).where(User.role == "admin")) or 0


@router.get("/users", response_model=list[UserOut])
async def list_users():
    async with Session() as session:
        return (await session.scalars(select(User).order_by(User.username))).all()


@router.post("/users", response_model=UserOut, status_code=201)
async def create_user(body: UserCreate):
    username = body.username.strip()
    if err := username_error(username) or password_error(body.password):
        raise HTTPException(422, err)
    async with Session() as session, session.begin():
        if await session.scalar(select(func.count()).select_from(User)) >= MAX_USERS:
            raise HTTPException(409, f"Można mieć najwyżej {MAX_USERS} kont")
        if await session.scalar(select(User.id).where(func.lower(User.username) == username.lower())) is not None:
            raise HTTPException(409, f"Konto {username} już istnieje")
        user = User(username=username, password_hash=await hash_password_async(body.password))
        user.set_role(body.role)
        session.add(user)
        await session.flush()
        await session.refresh(user)
    return user


@router.patch("/users/{user_id}", response_model=UserOut)
async def update_user(user_id: int, body: UserUpdate, me: AdminUser):
    if body.password is not None and (err := password_error(body.password)):
        raise HTTPException(422, err)
    async with Session() as session, session.begin():
        user = await session.get(User, user_id, with_for_update=True)
        if user is None:
            raise HTTPException(404, "Nie ma takiego konta")
        changed = False
        if body.role is not None and body.role != user.role:
            if user.role == "admin" and await _admins(session) <= 1:
                raise HTTPException(409, "To ostatni administrator – najpierw nadaj tę rolę innemu kontu")
            user.set_role(body.role)
            changed = True
        if body.password is not None:
            user.password_hash = await hash_password_async(body.password)
            changed = True
        if body.reset_totp and (user.totp_enabled or user.totp_secret):
            clear_totp(user)
            changed = True
        if changed and user.id != me.id:
            # Nowa rola albo hasło obowiązują od razu: konto loguje się od nowa
            await session.execute(delete(AuthSession).where(AuthSession.user_id == user.id))
        await session.flush()
        await session.refresh(user)
    forget_sessions()  # rola i hasło obowiązują od razu, także w pamięci sesji (security.py)
    return user


@router.delete("/users/{user_id}", status_code=204)
async def delete_user(user_id: int, me: AdminUser):
    if user_id == me.id:
        raise HTTPException(409, "Nie można usunąć własnego konta")
    async with Session() as session, session.begin():
        user = await session.get(User, user_id, with_for_update=True)
        if user is None:
            raise HTTPException(404, "Nie ma takiego konta")
        if user.role == "admin" and await _admins(session) <= 1:
            raise HTTPException(409, "To ostatni administrator")
        await session.delete(user)  # sesje i pulpity konta usuwa baza (ON DELETE CASCADE)
    forget_sessions()


@router.get("/audit", response_model=AuditPage)
async def audit_log(
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0, le=100_000),
    q: str | None = Query(None, max_length=64, description="tekst w koncie, akcji, ścieżce albo adresie IP"),
    kind: Literal["all", "auth", "changes", "denied"] = "all",
):
    """Dziennik audytu od najnowszych wpisów; `denied` = odrzucone (403) i nieudane logowania."""
    where = []
    if q:
        like = f"%{q.strip()}%"
        where.append(or_(AuditEntry.username.ilike(like), AuditEntry.action.ilike(like), AuditEntry.target.ilike(like), AuditEntry.ip.ilike(like)))
    auth_actions = ("login", "login_failed", "logout", "password", "setup")
    if kind == "auth":
        where.append(AuditEntry.action.in_(auth_actions))
    elif kind == "changes":
        where.append(AuditEntry.action.not_in(auth_actions))
    elif kind == "denied":
        where.append(or_(AuditEntry.action == "login_failed", AuditEntry.status == 403))
    async with Session() as session:
        total = await session.scalar(select(func.count()).select_from(AuditEntry).where(*where)) or 0
        rows = (
            await session.scalars(
                select(AuditEntry).where(*where).order_by(AuditEntry.time.desc(), AuditEntry.id.desc()).offset(offset).limit(limit)
            )
        ).all()
    return AuditPage(items=[AuditOut.model_validate(r) for r in rows], total=total)
