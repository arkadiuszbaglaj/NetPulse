"""Wykrywanie urządzeń (skan podsieci) i zanonimizowany raport urządzenia (od 0.73.0).

Opis: `docs/43-wykrywanie-urzadzen.md`. Obie trasy zmieniające (POST) są tylko dla administratora (domyślna reguła
w `security.py`) – skan wysyła zapytania SNMP do całej podsieci, a raport czyta całe gałęzie urządzenia.
"""

from __future__ import annotations

import time

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import select

from .. import devreport, discovery
from ..collector import credentials_for
from ..db import Session
from ..db.models import NON_SNMP_DRIVERS, Device
from ..snmp import SnmpCredentials, SnmpError
from .schemas import AuthProto, PrivProto, SnmpVersion, credential_error
from .security import client_ip, require_user

router = APIRouter(prefix="/api", tags=["wykrywanie"], dependencies=[Depends(require_user)])


class ScanIn(BaseModel):
    network: str = Field(min_length=7, max_length=64, description="np. 192.168.1.0/24 albo 192.168.1.10-40")
    port: int = Field(161, ge=1, le=65535)
    snmp_version: SnmpVersion = "2c"
    community: str | None = Field("public", max_length=255)
    v3_username: str | None = Field(None, max_length=128)
    v3_auth_protocol: AuthProto | None = None
    v3_auth_key: str | None = Field(None, max_length=255)
    v3_priv_protocol: PrivProto | None = None
    v3_priv_key: str | None = Field(None, max_length=255)
    v3_context: str | None = Field(None, max_length=128)

    def creds(self) -> SnmpCredentials:
        return SnmpCredentials(
            version=self.snmp_version,
            community=self.community or "public",
            username=self.v3_username,
            auth_protocol=self.v3_auth_protocol,
            auth_key=self.v3_auth_key,
            priv_protocol=self.v3_priv_protocol,
            priv_key=self.v3_priv_key,
            context_name=self.v3_context or "",
        )


class FoundOut(BaseModel):
    host: str
    name: str | None
    suggested_name: str
    descr: str | None
    object_id: str | None
    vendor: str | None
    model: str | None
    firmware: str | None
    kind: str
    driver: str
    generic: bool
    device_id: int | None


class ScanOut(BaseModel):
    network: str
    scanned: int
    took_s: float
    found: list[FoundOut]


class SuggestOut(BaseModel):
    network: str | None


@router.get("/discovery/suggest", response_model=SuggestOut)
async def suggest(request: Request):
    """Podsieć do skanu: tam, gdzie są już urządzenia, a bez nich – podsieć /24 komputera z przeglądarką."""
    async with Session() as session:
        hosts = list(await session.scalars(select(Device.host)))
    return SuggestOut(network=discovery.suggest_network(hosts) or discovery.suggest_network([client_ip(request)]))


@router.post("/discovery/scan", response_model=ScanOut)
async def scan(body: ScanIn):
    if err := credential_error(
        body.snmp_version, body.community, body.v3_username, body.v3_auth_protocol, body.v3_auth_key, body.v3_priv_protocol, body.v3_priv_key
    ):
        raise HTTPException(422, err)
    try:
        hosts = discovery.hosts_of(body.network)
    except discovery.DiscoveryError as exc:
        raise HTTPException(422, str(exc)) from exc
    started = time.monotonic()
    found = await discovery.discover(hosts, body.creds(), body.port)
    async with Session() as session:
        known = {d.host: d.id for d in await session.scalars(select(Device))}
    out = []
    for f in found:
        f.device_id = known.get(f.host)
        out.append(FoundOut(**f.as_dict(), suggested_name=discovery.default_name(f)))
    return ScanOut(network=body.network.strip(), scanned=len(hosts), took_s=round(time.monotonic() - started, 1), found=out)


@router.post("/devices/{device_id}/report")
async def device_report(device_id: int, interval: float = Query(30.0, ge=0, le=120, description="odstęp drugiego odczytu (s)")):
    """Zanonimizowany zrzut SNMP urządzenia do zgłoszenia „Nowe urządzenie” (bez zapisu; trwa ok. `interval` + odczyt)."""
    async with Session() as session:
        device = await session.get(Device, device_id)
    if device is None:
        raise HTTPException(404, "Nie ma takiego urządzenia")
    if device.driver in NON_SNMP_DRIVERS:
        raise HTTPException(409, "Raport dotyczy urządzeń odczytywanych przez SNMP")
    from ..snmp.client import PySnmpClient

    client = PySnmpClient(device.host, credentials_for(device), port=device.port, timeout=3.0, retries=1)
    try:
        report = await devreport.build(client, driver=device.detected_driver or device.driver, interval_s=interval)
    except SnmpError as exc:
        raise HTTPException(422, f"Brak odpowiedzi SNMP: {exc}") from exc
    finally:
        await client.close()
    return report
