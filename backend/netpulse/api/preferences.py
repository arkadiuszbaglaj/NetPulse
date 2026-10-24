"""Drobne ustawienia konta zapisywane po stronie serwera (działają na każdym urządzeniu użytkownika)."""

from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ValidationError
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert

from ..db import Session
from ..db.models import UserPreference
from .layout_schemas import RefreshPrefs
from .security import CurrentUser, require_user

router = APIRouter(prefix="/api/preferences", tags=["ustawienia konta"], dependencies=[Depends(require_user)])


class PreferencesOut(BaseModel):
    refresh: RefreshPrefs | None = None


@router.get("", response_model=PreferencesOut)
async def get_preferences(user: CurrentUser):
    async with Session() as session:
        row = await session.get(UserPreference, user.id)
    data = row.data if row else {}
    try:
        refresh = RefreshPrefs.model_validate(data["refresh"]) if "refresh" in data else None
    except ValidationError:
        refresh = None  # nieaktualna zawartość = brak (panel użyje domyślnych)
    return PreferencesOut(refresh=refresh)


@router.put("/refresh", response_model=RefreshPrefs)
async def put_refresh(prefs: RefreshPrefs, user: CurrentUser):
    """Interwał odświeżania i zakres czasu wykresów (jedno ustawienie na całe konto)."""
    async with Session() as session, session.begin():
        # Wiersz powstaje raz (równoczesne pierwsze zapisy nie kolidują), potem blokujemy go do aktualizacji
        await session.execute(insert(UserPreference).values(user_id=user.id, data={}).on_conflict_do_nothing())
        row = await session.scalar(select(UserPreference).where(UserPreference.user_id == user.id).with_for_update())
        row.data = {**(row.data or {}), "refresh": prefs.model_dump(mode="json")}
        row.updated_at = datetime.now(UTC)
    return prefs
