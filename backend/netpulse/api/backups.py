"""Kopie zapasowe bazy z panelu: API pośredniczy między panelem a usługą `updater` (jak przy aktualizacji).

Tylko administrator. Kopie leżą na serwerze w katalogu `backups` instalacji; przywracanie zatrzymuje na chwilę
API i kolektor (panel czeka, aż API wróci). Logika: updater/netpulse_updater/backups.py.
"""

from __future__ import annotations

import re
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ..config import settings
from .security import require_admin
from .updates import _configured, _forward, _token

router = APIRouter(prefix="/api/backups", tags=["kopie zapasowe"], dependencies=[Depends(require_admin)])

NAME_RE = re.compile(r"^netpulse-(?:(?:manual|prerestore)-)?\d{8}-\d{6}\.sql\.gz$")
LIST_TIMEOUT = 15.0
DUMP_TIMEOUT = 1800.0  # duża historia metryk = długi pg_dump


class BackupOut(BaseModel):
    name: str
    kind: str  # update | manual | prerestore
    size_bytes: int
    created_at: str


class RestoreOut(BaseModel):
    state: str  # idle | running | ok | failed
    backup: str | None = None
    step: str | None = None
    safety: str | None = None
    started_at: str | None = None
    finished_at: str | None = None
    error: str | None = None


class BackupsOut(BaseModel):
    backups: list[BackupOut]
    restore: RestoreOut


def _name(name: str) -> str:
    if not NAME_RE.match(name):
        raise HTTPException(404, "Nie ma takiej kopii")
    return name


def _out(payload: dict[str, Any]) -> BackupsOut:
    return BackupsOut(backups=payload.get("backups", []), restore=payload.get("restore") or {"state": "idle"})


@router.get("", response_model=BackupsOut)
async def list_backups():
    return _out(await _forward("GET", "/backups", LIST_TIMEOUT, ok=(200,)))


@router.post("", response_model=BackupsOut, status_code=201)
async def create_backup():
    """Nowa kopia bazy teraz (może potrwać przy dużej historii metryk)."""
    return _out(await _forward("POST", "/backups", DUMP_TIMEOUT, ok=(201,)))


@router.delete("/{name}", response_model=BackupsOut)
async def delete_backup(name: str):
    return _out(await _forward("DELETE", f"/backups/{_name(name)}", LIST_TIMEOUT, ok=(200,)))


@router.post("/{name}/restore", response_model=BackupsOut, status_code=202)
async def restore_backup(name: str):
    """Przywraca bazę z kopii. Przed tym powstaje kopia bezpieczeństwa; API zniknie na ok. minutę."""
    return _out(await _forward("POST", f"/backups/{_name(name)}/restore", DUMP_TIMEOUT, ok=(202,)))


@router.get("/{name}/download")
async def download_backup(name: str):
    """Plik kopii (.sql.gz) – do przechowania poza serwerem."""
    _name(name)
    if not _configured():
        raise HTTPException(503, "Usługa aktualizacji (kopie bazy) jest wyłączona albo jeszcze nie wystartowała")
    client = httpx.AsyncClient(timeout=httpx.Timeout(30.0, read=300.0))
    request = client.build_request(
        "GET", f"{settings.updater_url.rstrip('/')}/backups/{name}/file", headers={"Authorization": f"Bearer {_token()}"}
    )
    try:
        upstream = await client.send(request, stream=True)
    except httpx.HTTPError as exc:
        await client.aclose()
        raise HTTPException(502, "Usługa aktualizacji nie odpowiada. Sprawdź: netpulse status") from exc
    if upstream.status_code != 200:
        await upstream.aclose()
        await client.aclose()
        raise HTTPException(404 if upstream.status_code == 404 else 502, "Nie udało się pobrać kopii")

    async def body():
        try:
            async for chunk in upstream.aiter_bytes():
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()

    headers = {"Content-Disposition": f'attachment; filename="{name}"', "Cache-Control": "no-store"}
    if length := upstream.headers.get("content-length"):
        headers["Content-Length"] = length
    return StreamingResponse(body(), media_type="application/gzip", headers=headers)
