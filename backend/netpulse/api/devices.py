"""Urządzenia: lista, dodawanie, edycja, usuwanie, test SNMP; porty i sieci WiFi."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select

from ..collector import credentials_for
from ..db import Session
from ..db.models import Device, Interface, InterfaceMetric, WifiNetwork
from ..drivers import PollResult
from ..probe import probe as snmp_probe
from ..snmp import SnmpCredentials, SnmpError
from .schemas import (
    DeviceCreate,
    DeviceOut,
    DeviceUpdate,
    InterfaceOut,
    ProbeInterface,
    ProbeOut,
    ProbeWifi,
    SnmpTarget,
    WifiOut,
    credential_error,
)
from .security import require_user

router = APIRouter(prefix="/api", tags=["urządzenia"], dependencies=[Depends(require_user)])

# Pola SNMP, które przy SNMPv3 nie mają community i odwrotnie
_V3_FIELDS = ("v3_username", "v3_auth_protocol", "v3_auth_key", "v3_priv_protocol", "v3_priv_key", "v3_context")


def _creds(t: SnmpTarget) -> SnmpCredentials:
    return SnmpCredentials(
        version=t.snmp_version,
        community=t.community or "public",
        username=t.v3_username,
        auth_protocol=t.v3_auth_protocol,
        auth_key=t.v3_auth_key,
        priv_protocol=t.v3_priv_protocol,
        priv_key=t.v3_priv_key,
        context_name=t.v3_context or "",
    )


async def _probe_or_422(host: str, port: int, creds: SnmpCredentials, driver: str) -> PollResult:
    try:
        return await snmp_probe(host, port, creds, driver)
    except SnmpError as exc:
        raise HTTPException(422, f"Brak odpowiedzi SNMP z {host}: {exc}") from exc


def _probe_out(r: PollResult) -> ProbeOut:
    s = r.system
    return ProbeOut(
        driver=r.driver,
        name=s.name,
        vendor=s.vendor,
        model=s.model,
        firmware=s.firmware,
        kind=s.kind,
        uptime_s=s.uptime_s,
        interfaces=[
            ProbeInterface(
                if_index=i.if_index,
                name=i.name,
                label=i.label,
                alias=i.alias,
                role=i.role,
                hidden=i.hidden,
                oper_status=i.oper_status,
                speed_mbps=i.speed_mbps,
            )
            for i in r.interfaces
        ],
        wifi=[
            ProbeWifi(ssid=w.ssid, radio=w.radio, channel=w.channel, clients=w.clients, hidden=w.hidden)
            for w in r.wifi
        ],
    )


async def _get_device(session, device_id: int) -> Device:
    device = await session.get(Device, device_id)
    if not device:
        raise HTTPException(404, "Nie ma takiego urządzenia")
    return device


async def _host_taken(session, host: str, except_id: int | None = None) -> bool:
    stmt = select(Device.id).where(Device.host == host)
    if except_id is not None:
        stmt = stmt.where(Device.id != except_id)
    return await session.scalar(stmt) is not None


# --- urządzenia --------------------------------------------------------------


@router.get("/devices", response_model=list[DeviceOut])
async def list_devices():
    async with Session() as session:
        return (await session.scalars(select(Device).order_by(Device.id))).all()


@router.post("/probe", response_model=ProbeOut)
async def probe_target(body: SnmpTarget):
    """Test połączenia SNMP bez zapisu – do formularza „Dodaj urządzenie”."""
    if err := body.credential_error():
        raise HTTPException(422, err)
    return _probe_out(await _probe_or_422(body.host, body.port, _creds(body), body.driver))


@router.post("/devices", response_model=DeviceOut, status_code=201)
async def create_device(body: DeviceCreate, probe: bool = Query(True, description="najpierw sprawdź SNMP")):
    if err := body.credential_error():
        raise HTTPException(422, err)
    async with Session() as session:
        if await _host_taken(session, body.host):
            raise HTTPException(409, f"Urządzenie {body.host} już jest dodane")
    result = await _probe_or_422(body.host, body.port, _creds(body), body.driver) if probe else None

    values = body.model_dump()
    if body.snmp_version == "3":
        values["community"] = None
    else:
        values.update(dict.fromkeys(_V3_FIELDS))
    device = Device(**values)
    if result:
        # Od razu pokaż, co to za sprzęt – kolektor uzupełni resztę przy pierwszym odczycie
        s = result.system
        device.detected_driver = result.driver
        device.kind = s.kind
        device.vendor, device.model, device.firmware = s.vendor, s.model, s.firmware
        device.sys_name, device.sys_descr, device.sys_object_id = s.name, s.descr, s.object_id
        device.uptime_s = s.uptime_s
    async with Session() as session, session.begin():
        if await _host_taken(session, body.host):
            raise HTTPException(409, f"Urządzenie {body.host} już jest dodane")
        session.add(device)
        await session.flush()
        await session.refresh(device)  # id i created_at nadaje baza
    return device


@router.get("/devices/{device_id}", response_model=DeviceOut)
async def get_device(device_id: int):
    async with Session() as session:
        return await _get_device(session, device_id)


@router.patch("/devices/{device_id}", response_model=DeviceOut)
async def update_device(device_id: int, body: DeviceUpdate):
    """Zmiana wybranych pól. Sekrety (community, klucze v3) pominięte w żądaniu zostają bez zmian."""
    changes = body.model_dump(exclude_unset=True)
    for field in ("name", "enabled", "host", "port", "driver", "snmp_version"):
        if field in changes and changes[field] is None:
            raise HTTPException(422, f"Pole {field} nie może być puste")
    async with Session() as session, session.begin():
        device = await _get_device(session, device_id)
        if "host" in changes and await _host_taken(session, changes["host"], except_id=device_id):
            raise HTTPException(409, f"Urządzenie {changes['host']} już jest dodane")
        for field, value in changes.items():
            setattr(device, field, value)
        if err := credential_error(
            device.snmp_version,
            device.community,
            device.v3_username,
            device.v3_auth_protocol,
            device.v3_auth_key,
            device.v3_priv_protocol,
            device.v3_priv_key,
        ):
            raise HTTPException(422, err)
    return device


@router.delete("/devices/{device_id}", status_code=204)
async def delete_device(device_id: int):
    """Usuwa urządzenie razem z portami i historią metryk."""
    async with Session() as session, session.begin():
        await session.delete(await _get_device(session, device_id))


@router.post("/devices/{device_id}/probe", response_model=ProbeOut)
async def probe_device(device_id: int):
    """Test SNMP zapisanego urządzenia (z zapisanymi danymi logowania)."""
    async with Session() as session:
        device = await _get_device(session, device_id)
    return _probe_out(await _probe_or_422(device.host, device.port, credentials_for(device), device.driver))


# --- porty i WiFi ------------------------------------------------------------


@router.get("/devices/{device_id}/interfaces", response_model=list[InterfaceOut])
async def device_interfaces(device_id: int, include_hidden: bool = False):
    async with Session() as session:
        await _get_device(session, device_id)
        stmt = select(Interface).where(Interface.device_id == device_id).order_by(Interface.if_index)
        if not include_hidden:
            stmt = stmt.where(Interface.hidden.is_(False))
        interfaces = (await session.scalars(stmt)).all()
        if not interfaces:
            return []
        # Ostatnia próbka dla każdego interfejsu (z ostatnich 5 minut)
        since = datetime.now(UTC) - timedelta(minutes=5)
        latest = (
            select(InterfaceMetric.interface_id, InterfaceMetric.in_bps, InterfaceMetric.out_bps)
            .distinct(InterfaceMetric.interface_id)
            .where(
                InterfaceMetric.interface_id.in_([i.id for i in interfaces]),
                InterfaceMetric.time >= since,
            )
            .order_by(InterfaceMetric.interface_id, InterfaceMetric.time.desc())
        )
        last = {r.interface_id: r for r in await session.execute(latest)}
    out = []
    for i in interfaces:
        item = InterfaceOut.model_validate(i)
        if i.id in last:
            item.in_bps, item.out_bps = last[i.id].in_bps, last[i.id].out_bps
        out.append(item)
    return out


@router.get("/devices/{device_id}/wifi", response_model=list[WifiOut])
async def device_wifi(device_id: int, include_hidden: bool = False):
    async with Session() as session:
        await _get_device(session, device_id)
        stmt = select(WifiNetwork).where(WifiNetwork.device_id == device_id).order_by(WifiNetwork.key)
        if not include_hidden:
            stmt = stmt.where(WifiNetwork.hidden.is_(False))
        return (await session.scalars(stmt)).all()
