"""HTTPS panelu (od 0.62.0): stan certyfikatu, pobranie CA NetPulse, adresy dopisane przez administratora."""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field

from .. import tls
from ..config import settings
from .security import AdminUser, require_user

router = APIRouter(prefix="/api/system/tls", tags=["serwer"], dependencies=[Depends(require_user)])


class TlsOut(BaseModel):
    available: bool
    mode: str
    https_port: int | None
    names: list[str]
    requested: list[str]
    not_after: datetime | None
    issuer: str | None
    ca_fingerprint: str | None
    # Adres, pod którym otwarto panel, i czy certyfikat go obejmuje
    host: str
    host_covered: bool
    https: bool


class NamesIn(BaseModel):
    names: list[str] = Field(max_length=tls.MAX_NAMES)


def _https_port() -> int | None:
    try:
        return int(settings.https_port) if settings.https_port else None
    except ValueError:
        return None


def _out(request: Request) -> TlsOut:
    st = tls.state()
    host = tls.host_of(request.headers.get("host", ""))
    return TlsOut(
        available=st.available,
        mode=st.mode,
        https_port=_https_port() if st.available else None,
        names=st.names,
        requested=st.requested,
        not_after=st.not_after,
        issuer=st.issuer,
        ca_fingerprint=st.ca_fingerprint,
        host=host,
        host_covered=st.available and tls.covers(st.names, host),
        https=request.url.scheme == "https",
    )


@router.get("", response_model=TlsOut)
async def status(request: Request):
    return _out(request)


@router.get("/ca.pem")
async def ca_certificate():
    """Certyfikat lokalnego CA NetPulse – do zaimportowania w systemie albo przeglądarce (bez klucza)."""
    pem = tls.ca_pem()
    if pem is None:
        raise HTTPException(404, "Brak certyfikatu CA (kontener proxy jeszcze go nie utworzył)")
    return Response(
        pem,
        media_type="application/x-pem-file",
        headers={"Content-Disposition": 'attachment; filename="netpulse-ca.pem"'},
    )


@router.put("/names", response_model=TlsOut)
async def set_names(body: NamesIn, request: Request, _: AdminUser):
    """Adresy (oprócz tych z .env), pod którymi panel jest dostępny; certyfikat powstaje w ciągu ~30 s."""
    try:
        tls.save_requested(body.names)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except OSError as exc:
        raise HTTPException(409, "Nie można zapisać adresów – czy kontener proxy działa?") from exc
    return _out(request)
