"""Proxmox VE: serwery (token API), maszyny VM/LXC, magazyny i stan kopii zapasowych.

Zmiany serwerów może robić tylko administrator; odczyt – każdy zalogowany. Sekret tokenu nie wraca z API.
Odczyt danych z Proxmoxa: proxmox_collector.py (węzły stają się urządzeniami NetPulse).
"""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import delete, select

from ..db import Session
from ..db.models import Device, ProxmoxGuest, ProxmoxNode, ProxmoxServer, ProxmoxStorage
from ..proxmox import ProxmoxApi, ProxmoxError
from .schemas import _check_host
from .security import AdminUser, require_user

router = APIRouter(prefix="/api/proxmox", tags=["Proxmox"], dependencies=[Depends(require_user)])

TOKEN_ID = r"^[^@\s!]+@[^@\s!]+![A-Za-z0-9_.-]+$"  # użytkownik@realm!id


class ServerTarget(BaseModel):
    host: str = Field(max_length=255)
    port: int = Field(8006, ge=1, le=65535)
    token_id: str = Field(max_length=255, pattern=TOKEN_ID)
    token_secret: str = Field(min_length=8, max_length=255)
    verify_tls: bool = False

    @field_validator("host")
    @classmethod
    def _host(cls, v: str) -> str:
        return _check_host(v)


class ServerCreate(ServerTarget):
    name: str = Field(min_length=1, max_length=128)
    enabled: bool = True


class ServerUpdate(BaseModel):
    """Pola pominięte zostają bez zmian; brak sekretu tokenu znaczy „bez zmian”."""

    name: str | None = Field(None, min_length=1, max_length=128)
    host: str | None = Field(None, max_length=255)
    port: int | None = Field(None, ge=1, le=65535)
    token_id: str | None = Field(None, max_length=255, pattern=TOKEN_ID)
    token_secret: str | None = Field(None, min_length=8, max_length=255)
    verify_tls: bool | None = None
    enabled: bool | None = None

    @field_validator("host")
    @classmethod
    def _host(cls, v: str | None) -> str | None:
        return _check_host(v) if v is not None else None


class ServerOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    host: str
    port: int
    token_id: str
    verify_tls: bool
    enabled: bool
    status: str
    version: str | None
    cluster_name: str | None
    last_polled_at: datetime | None
    last_ok_at: datetime | None
    last_error: str | None
    created_at: datetime


class ServerProbe(BaseModel):
    version: str | None
    cluster: str | None
    nodes: int
    guests: int
    storages: int


class GuestOut(BaseModel):
    server_id: int
    server: str
    vmid: int
    node: str
    device_id: int | None  # urządzenie węzła (do wykresów)
    type: str
    name: str
    key: str  # klucz w metrykach i alertach
    status: str
    template: bool
    tags: str | None
    cpus: int | None
    cpu_percent: float | None
    mem_used: int | None
    mem_total: int | None
    disk_used: int | None
    disk_total: int | None
    uptime_s: int | None
    last_backup_at: datetime | None
    updated_at: datetime


class StorageOut(BaseModel):
    server_id: int
    node: str
    storage: str
    type: str | None
    shared: bool
    active: bool
    content: str | None
    used_bytes: int | None
    total_bytes: int | None
    updated_at: datetime


class NodeOut(BaseModel):
    server_id: int
    node: str
    device_id: int
    ip: str | None
    online: bool
    backup_status: str | None
    backup_at: datetime | None


async def _probe(t: ServerTarget) -> ServerProbe:
    api = ProxmoxApi(t.host, t.token_id, t.token_secret, port=t.port, verify_tls=t.verify_tls)
    try:
        snap = await api.snapshot()
    except ProxmoxError as exc:
        raise HTTPException(422, f"Proxmox {t.host}: {exc}") from exc
    finally:
        await api.close()
    return ServerProbe(version=snap.version, cluster=snap.cluster, nodes=len(snap.nodes), guests=len(snap.guests), storages=len(snap.storages))


async def _get(session, server_id: int) -> ProxmoxServer:
    server = await session.get(ProxmoxServer, server_id)
    if server is None:
        raise HTTPException(404, "Nie ma takiego serwera Proxmox")
    return server


async def _host_taken(session, host: str, except_id: int | None = None) -> bool:
    stmt = select(ProxmoxServer.id).where(ProxmoxServer.host == host)
    if except_id is not None:
        stmt = stmt.where(ProxmoxServer.id != except_id)
    return await session.scalar(stmt) is not None


# --- serwery ------------------------------------------------------------------------------


@router.get("/servers", response_model=list[ServerOut])
async def list_servers():
    async with Session() as session:
        return (await session.scalars(select(ProxmoxServer).order_by(ProxmoxServer.id))).all()


@router.post("/probe", response_model=ServerProbe)
async def probe_target(body: ServerTarget, _: AdminUser):
    """Test połączenia i tokenu bez zapisu – do formularza „Dodaj serwer Proxmox”."""
    return await _probe(body)


@router.post("/servers", response_model=ServerOut, status_code=201)
async def create_server(body: ServerCreate, _: AdminUser, probe: bool = Query(True, description="najpierw sprawdź połączenie")):
    async with Session() as session:
        if await _host_taken(session, body.host):
            raise HTTPException(409, f"Serwer Proxmox {body.host} już jest dodany")
    info = await _probe(body) if probe else None
    server = ProxmoxServer(**body.model_dump(), version=info.version if info else None, cluster_name=info.cluster if info else None)
    async with Session() as session, session.begin():
        if await _host_taken(session, body.host):
            raise HTTPException(409, f"Serwer Proxmox {body.host} już jest dodany")
        session.add(server)
        await session.flush()
        await session.refresh(server)
    return server


@router.patch("/servers/{server_id}", response_model=ServerOut)
async def update_server(server_id: int, body: ServerUpdate, _: AdminUser):
    changes = body.model_dump(exclude_unset=True)
    for field, value in changes.items():
        if value is None:
            raise HTTPException(422, f"Pole {field} nie może być puste")
    async with Session() as session, session.begin():
        server = await _get(session, server_id)
        if "host" in changes and await _host_taken(session, changes["host"], except_id=server_id):
            raise HTTPException(409, f"Serwer Proxmox {changes['host']} już jest dodany")
        for field, value in changes.items():
            setattr(server, field, value)
    return server


@router.delete("/servers/{server_id}", status_code=204)
async def delete_server(server_id: int, _: AdminUser):
    """Usuwa serwer razem z jego węzłami w panelu (urządzenia i ich historia metryk), maszynami i magazynami."""
    async with Session() as session, session.begin():
        server = await _get(session, server_id)
        device_ids = (await session.scalars(select(ProxmoxNode.device_id).where(ProxmoxNode.server_id == server_id))).all()
        await session.delete(server)
        if device_ids:
            await session.execute(delete(Device).where(Device.id.in_(device_ids)))


@router.post("/servers/{server_id}/probe", response_model=ServerProbe)
async def probe_saved_server(server_id: int, _: AdminUser):
    async with Session() as session:
        s = await _get(session, server_id)
    return await _probe(ServerTarget(host=s.host, port=s.port, token_id=s.token_id, token_secret=s.token_secret or "x" * 8, verify_tls=s.verify_tls))


# --- dane ---------------------------------------------------------------------------------


@router.get("/guests", response_model=list[GuestOut])
async def list_guests(device_id: int | None = Query(None, description="tylko maszyny na tym węźle")):
    """Maszyny VM i kontenery LXC z ostatniego odczytu (bez szablonów na końcu listy)."""
    async with Session() as session:
        servers = {s.id: s.name for s in (await session.scalars(select(ProxmoxServer))).all()}
        nodes = {(n.server_id, n.node): n.device_id for n in (await session.scalars(select(ProxmoxNode))).all()}
        guests = (await session.scalars(select(ProxmoxGuest).order_by(ProxmoxGuest.template, ProxmoxGuest.vmid))).all()
    out = [
        GuestOut(
            **{c: getattr(g, c) for c in GuestOut.model_fields if hasattr(g, c) and c not in ("server", "device_id", "key")},
            server=servers.get(g.server_id, "?"),
            device_id=nodes.get((g.server_id, g.node)),
            key=f"{g.name} ({g.vmid})",
        )
        for g in guests
    ]
    return [g for g in out if device_id is None or g.device_id == device_id]


@router.get("/storages", response_model=list[StorageOut])
async def list_storages():
    async with Session() as session:
        rows = (await session.scalars(select(ProxmoxStorage).order_by(ProxmoxStorage.node, ProxmoxStorage.storage))).all()
    return [StorageOut.model_validate(r, from_attributes=True) for r in rows]


@router.get("/nodes", response_model=list[NodeOut])
async def list_nodes():
    async with Session() as session:
        rows = (await session.scalars(select(ProxmoxNode).order_by(ProxmoxNode.server_id, ProxmoxNode.node))).all()
    return [NodeOut.model_validate(r, from_attributes=True) for r in rows]
