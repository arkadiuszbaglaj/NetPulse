"""Kontrolery UniFi (klucz API): zarządzanie, klienci sieci i PoE na portach switchy."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import select

from ..db import Session
from ..db.models import Controller, Device, Interface, NetworkClient, PoeBudgetMetric, PoePortMetric
from ..unifi import UnifiApi, UnifiError
from .schemas import _check_host
from .security import require_user

router = APIRouter(prefix="/api", tags=["UniFi"], dependencies=[Depends(require_user)])

CURRENT_WINDOW = timedelta(minutes=5)


class ControllerTarget(BaseModel):
    host: str = Field(max_length=255)
    port: int = Field(443, ge=1, le=65535)
    api_key: str = Field(min_length=8, max_length=255)
    site: str = Field("default", min_length=1, max_length=64)
    verify_tls: bool = False

    @field_validator("host")
    @classmethod
    def _host(cls, v: str) -> str:
        return _check_host(v)


class ControllerCreate(ControllerTarget):
    name: str = Field(min_length=1, max_length=128)
    enabled: bool = True


class ControllerUpdate(BaseModel):
    """Pola pominięte zostają bez zmian; klucz API nigdy nie wraca do klienta, więc jego brak znaczy „bez zmian”."""

    name: str | None = Field(None, min_length=1, max_length=128)
    host: str | None = Field(None, max_length=255)
    port: int | None = Field(None, ge=1, le=65535)
    api_key: str | None = Field(None, min_length=8, max_length=255)
    site: str | None = Field(None, min_length=1, max_length=64)
    verify_tls: bool | None = None
    enabled: bool | None = None

    @field_validator("host")
    @classmethod
    def _host(cls, v: str | None) -> str | None:
        return _check_host(v) if v is not None else None


class ControllerOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    host: str
    port: int
    site: str
    verify_tls: bool
    enabled: bool
    app_version: str | None
    status: str
    last_polled_at: datetime | None
    last_ok_at: datetime | None
    last_error: str | None
    created_at: datetime


class ControllerProbe(BaseModel):
    app_version: str | None
    devices: int
    clients: int


class ClientOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    mac: str
    name: str | None
    ip: str | None
    is_wired: bool
    is_guest: bool
    essid: str | None
    radio: str | None
    signal_dbm: int | None
    tx_rate_kbps: int | None
    rx_rate_kbps: int | None
    uplink_device_id: int | None
    uplink_name: str | None
    uplink_port: int | None
    connected_s: int | None
    updated_at: datetime


class PoePortOut(BaseModel):
    port_idx: int
    label: str | None
    power_w: float | None
    voltage_v: float | None
    current_ma: float | None
    mode: str | None
    poe_class: str | None
    delivering: bool | None


class PoeBudgetOut(BaseModel):
    used_w: float | None
    max_w: float | None


class PoeOut(BaseModel):
    budget: PoeBudgetOut | None
    ports: list[PoePortOut]


async def _probe(t: ControllerTarget) -> ControllerProbe:
    api = UnifiApi(t.host, t.api_key, port=t.port, site=t.site, verify_tls=t.verify_tls)
    try:
        version = await api.app_version()
        devices = await api.devices()
        clients = await api.clients()
    except UnifiError as exc:
        raise HTTPException(422, f"Kontroler {t.host}: {exc}") from exc
    finally:
        await api.close()
    return ControllerProbe(app_version=version, devices=len(devices), clients=len(clients))


async def _get(session, controller_id: int) -> Controller:
    controller = await session.get(Controller, controller_id)
    if controller is None:
        raise HTTPException(404, "Nie ma takiego kontrolera")
    return controller


async def _host_taken(session, host: str, except_id: int | None = None) -> bool:
    stmt = select(Controller.id).where(Controller.host == host)
    if except_id is not None:
        stmt = stmt.where(Controller.id != except_id)
    return await session.scalar(stmt) is not None


# --- kontrolery --------------------------------------------------------------


@router.get("/controllers", response_model=list[ControllerOut])
async def list_controllers():
    async with Session() as session:
        return (await session.scalars(select(Controller).order_by(Controller.id))).all()


@router.post("/controllers/probe", response_model=ControllerProbe)
async def probe_controller(body: ControllerTarget):
    """Test połączenia i klucza API bez zapisu – do formularza „Dodaj kontroler”."""
    return await _probe(body)


@router.post("/controllers", response_model=ControllerOut, status_code=201)
async def create_controller(body: ControllerCreate, probe: bool = Query(True, description="najpierw sprawdź połączenie")):
    async with Session() as session:
        if await _host_taken(session, body.host):
            raise HTTPException(409, f"Kontroler {body.host} już jest dodany")
    version = (await _probe(body)).app_version if probe else None
    controller = Controller(**body.model_dump(), app_version=version)
    async with Session() as session, session.begin():
        if await _host_taken(session, body.host):
            raise HTTPException(409, f"Kontroler {body.host} już jest dodany")
        session.add(controller)
        await session.flush()
        await session.refresh(controller)
    return controller


@router.patch("/controllers/{controller_id}", response_model=ControllerOut)
async def update_controller(controller_id: int, body: ControllerUpdate):
    changes = body.model_dump(exclude_unset=True)
    for field, value in changes.items():
        if value is None:
            raise HTTPException(422, f"Pole {field} nie może być puste")
    async with Session() as session, session.begin():
        controller = await _get(session, controller_id)
        if "host" in changes and await _host_taken(session, changes["host"], except_id=controller_id):
            raise HTTPException(409, f"Kontroler {changes['host']} już jest dodany")
        for field, value in changes.items():
            setattr(controller, field, value)
    return controller


@router.delete("/controllers/{controller_id}", status_code=204)
async def delete_controller(controller_id: int):
    """Usuwa kontroler i jego klientów; historia PoE zostaje przy urządzeniach."""
    async with Session() as session, session.begin():
        await session.delete(await _get(session, controller_id))


@router.post("/controllers/{controller_id}/probe", response_model=ControllerProbe)
async def probe_saved_controller(controller_id: int):
    async with Session() as session:
        c = await _get(session, controller_id)
    return await _probe(ControllerTarget(host=c.host, port=c.port, api_key=c.api_key, site=c.site, verify_tls=c.verify_tls))


# --- klienci i PoE -----------------------------------------------------------


@router.get("/clients", response_model=list[ClientOut])
async def list_clients(kind: str | None = Query(None, pattern="^(wifi|wired)$")):
    """Klienci sieci z ostatniego odczytu kontrolera (WiFi: sygnał i sieć, kabel: port)."""
    stmt = select(NetworkClient).order_by(NetworkClient.is_wired, NetworkClient.name, NetworkClient.mac)
    if kind:
        stmt = stmt.where(NetworkClient.is_wired.is_(kind == "wired"))
    async with Session() as session:
        return (await session.scalars(stmt)).all()


@router.get("/devices/{device_id}/poe", response_model=PoeOut)
async def device_poe(device_id: int):
    """Bieżący PoE switcha: moc na portach i budżet. Puste, gdy kontroler nic nie podał (SNMP samo tego nie ma)."""
    since = datetime.now(UTC) - CURRENT_WINDOW
    async with Session() as session:
        if await session.get(Device, device_id) is None:
            raise HTTPException(404, "Nie ma takiego urządzenia")
        latest = (
            select(PoePortMetric)
            .distinct(PoePortMetric.port_idx)
            .where(PoePortMetric.device_id == device_id, PoePortMetric.time >= since)
            .order_by(PoePortMetric.port_idx, PoePortMetric.time.desc())
        )
        ports = (await session.scalars(latest)).all()
        budget = await session.scalar(
            select(PoeBudgetMetric)
            .where(PoeBudgetMetric.device_id == device_id, PoeBudgetMetric.time >= since)
            .order_by(PoeBudgetMetric.time.desc())
            .limit(1)
        )
        # Nazwy portów z UniFi (alias SNMP, np. „AP U6+”) – switch UniFi nazywa porty 0/1…0/8
        aliases = {
            i.name: i.alias or i.label
            for i in (await session.scalars(select(Interface).where(Interface.device_id == device_id))).all()
        }
    return PoeOut(
        budget=PoeBudgetOut(used_w=budget.used_w, max_w=budget.max_w) if budget else None,
        ports=[
            PoePortOut(
                port_idx=p.port_idx,
                label=aliases.get(f"0/{p.port_idx}"),
                power_w=p.power_w,
                voltage_v=p.voltage_v,
                current_ma=p.current_ma,
                mode=p.poe_mode,
                poe_class=p.poe_class,
                delivering=p.delivering,
            )
            for p in ports
        ],
    )
