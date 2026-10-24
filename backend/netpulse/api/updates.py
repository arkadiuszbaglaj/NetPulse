"""Aktualizacje z panelu: API pośredniczy między panelem a usługą `updater`.

Samo API nie ma dostępu do Dockera. Usługa aktualizacji (osobny kontener, sieć wewnętrzna, token)
sprawdza wersje i instaluje je na polecenie; zlecić aktualizację może tylko administrator.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .. import __version__
from ..config import settings
from .security import AdminUser, require_user

router = APIRouter(prefix="/api/updates", tags=["aktualizacje"], dependencies=[Depends(require_user)])

STATUS_TIMEOUT = 10.0
CHECK_TIMEOUT = 150.0  # git fetch ze źródła może chwilę potrwać


class UpdaterState(BaseModel):
    configured: bool
    reachable: bool
    message: str | None = None


class CurrentOut(BaseModel):
    version: str | None = None
    commit: str | None = None
    branch: str | None = None


class ChangeOut(BaseModel):
    sha: str
    subject: str


class CheckInfo(BaseModel):
    current: CurrentOut
    latest: CurrentOut
    behind: int
    ahead: int
    diverged: bool
    update_available: bool
    changes: list[ChangeOut]
    checked_at: str | None = None


class PhaseOut(BaseModel):
    id: str
    status: str


class JobOut(BaseModel):
    state: str  # idle | running | ok | failed | rolled_back
    phase: str | None = None
    phases: list[PhaseOut] = []
    started_at: str | None = None
    finished_at: str | None = None
    from_version: str | None = None
    to_version: str | None = None
    from_commit: str | None = None
    to_commit: str | None = None
    error: str | None = None
    note: str | None = None
    log: list[str] = []


class UpdatesOut(BaseModel):
    installed_version: str
    updater: UpdaterState
    current: CurrentOut | None = None
    info: CheckInfo | None = None
    job: JobOut | None = None


class _Unreachable(Exception):
    pass


def _token() -> str:
    """Token usługi aktualizacji: zmienna środowiskowa albo plik z wolumenu (czytany przy każdym żądaniu,
    bo usługa tworzy go przy pierwszym starcie – API może wystartować wcześniej)."""
    if settings.updater_token:
        return settings.updater_token
    if settings.updater_token_file:
        try:
            return Path(settings.updater_token_file).read_text(encoding="utf-8").strip()
        except OSError:
            return ""
    return ""


def _configured() -> bool:
    return bool(settings.updater_url and _token())


async def _call(method: str, path: str, timeout: float) -> tuple[int, dict[str, Any]]:
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            r = await client.request(
                method,
                f"{settings.updater_url.rstrip('/')}{path}",
                headers={"Authorization": f"Bearer {_token()}"},
            )
    except httpx.HTTPError as exc:
        raise _Unreachable from exc
    try:
        return r.status_code, r.json()
    except ValueError:
        return 502, {"error": "Nieprawidłowa odpowiedź usługi aktualizacji."}


def _out(updater: UpdaterState, payload: dict[str, Any] | None = None) -> UpdatesOut:
    payload = payload or {}
    return UpdatesOut(
        installed_version=__version__,
        updater=updater,
        current=payload.get("current"),
        info=payload.get("info"),
        job=payload.get("job"),
    )


async def _forward(method: str, path: str, timeout: float, ok: tuple[int, ...]) -> dict[str, Any]:
    """Wywołuje usługę aktualizacji; błędy zamienia na czytelne odpowiedzi HTTP."""
    if not _configured():
        raise HTTPException(503, "Aktualizacja z panelu jest wyłączona albo usługa aktualizacji jeszcze nie wystartowała. Zaktualizuj poleceniem: netpulse update")
    try:
        code, payload = await _call(method, path, timeout)
    except _Unreachable:
        raise HTTPException(502, "Usługa aktualizacji nie odpowiada. Sprawdź: netpulse status") from None
    if code in ok:
        return payload
    message = payload.get("error", "Usługa aktualizacji zgłosiła błąd.")
    if code == 409:
        raise HTTPException(409, message)
    if code in (401, 503):
        raise HTTPException(502, "Usługa aktualizacji odrzuciła żądanie. Uruchom ponownie usługi: netpulse restart")
    raise HTTPException(502, message)


@router.get("", response_model=UpdatesOut)
async def get_updates():
    """Zainstalowana wersja, wynik ostatniego sprawdzenia i stan aktualizacji (z logiem)."""
    if not _configured():
        return _out(
            UpdaterState(
                configured=False,
                reachable=False,
                message="Aktualizacja z panelu jest wyłączona albo usługa aktualizacji jeszcze nie wystartowała. Zaktualizuj poleceniem: netpulse update",
            )
        )
    try:
        code, payload = await _call("GET", "/status", STATUS_TIMEOUT)
    except _Unreachable:
        return _out(
            UpdaterState(
                configured=True,
                reachable=False,
                message="Usługa aktualizacji nie odpowiada. Sprawdź: netpulse status",
            )
        )
    if code != 200:
        return _out(
            UpdaterState(
                configured=True,
                reachable=False,
                message="Usługa aktualizacji odrzuciła żądanie. Uruchom ponownie usługi: netpulse restart",
            )
        )
    problem = payload.get("problem")
    if problem:
        return _out(UpdaterState(configured=True, reachable=False, message=problem), payload)
    return _out(UpdaterState(configured=True, reachable=True), payload)


@router.post("/check", response_model=UpdatesOut)
async def check_updates(_: AdminUser):
    """Sprawdza w źródle, czy jest nowa wersja (niczego nie instaluje)."""
    payload = await _forward("POST", "/check", CHECK_TIMEOUT, ok=(200,))
    return _out(UpdaterState(configured=True, reachable=True), payload)


@router.post("/apply", response_model=UpdatesOut, status_code=202)
async def apply_update(_: AdminUser):
    """Zleca instalację najnowszej wersji (kopia bazy, aktualizacja, test, ewentualne wycofanie)."""
    payload = await _forward("POST", "/update", STATUS_TIMEOUT, ok=(202,))
    return _out(UpdaterState(configured=True, reachable=True), payload)
