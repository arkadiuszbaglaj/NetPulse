"""Agenci serwerów Linux (etap 10B).

- Panel (administrator): dodanie serwera z agentem i wygenerowanie tokenu, nowy token, lista agentów.
  Usunięcie agenta = usunięcie urządzenia (DELETE /api/devices/{id}).
- Agent (token w nagłówku `Authorization: Bearer …`): POST /api/agent/v1/report co interwał kolektora.
  Push działa za NAT-em i bez otwierania portów na monitorowanym serwerze.
- Instalacja jednym poleceniem: GET /agent/install.sh i GET /agent/netpulse-agent.py (bez logowania – to nie sekret).
"""

from __future__ import annotations

import secrets
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert

from .. import __version__
from ..auth import hash_token, new_token
from ..config import settings
from ..db import Session
from ..db.models import Agent, Device, DeviceMetric, DiskMetric, Metric, ServerMetric
from .security import client_ip, require_admin

AGENT_DIR = Path(__file__).resolve().parent.parent / "agent"
TOKEN_PREFIX = "npa_"
# Raport częściej niż co tyle sekund to błąd konfiguracji albo nadużycie – odrzucamy
MIN_REPORT_GAP = timedelta(seconds=5)

admin_router = APIRouter(prefix="/api/agents", tags=["agenci"], dependencies=[Depends(require_admin)])
push_router = APIRouter(tags=["agenci"])


# --- panel ------------------------------------------------------------------------


class AgentCreate(BaseModel):
    name: str = Field(min_length=1, max_length=128)


class AgentOut(BaseModel):
    id: int
    device_id: int
    name: str
    enabled: bool
    status: str
    token_hint: str
    created_at: datetime
    last_seen_at: datetime | None
    last_ip: str | None
    agent_version: str | None
    hostname: str | None


class AgentToken(BaseModel):
    agent: AgentOut
    token: str


def _out(agent: Agent, device: Device) -> AgentOut:
    return AgentOut(
        id=agent.id,
        device_id=device.id,
        name=device.name,
        enabled=device.enabled,
        status=device.status,
        token_hint=agent.token_hint,
        created_at=agent.created_at,
        last_seen_at=agent.last_seen_at,
        last_ip=agent.last_ip,
        agent_version=agent.agent_version,
        hostname=agent.hostname,
    )


def _new_token() -> tuple[str, str, str]:
    token = TOKEN_PREFIX + new_token()
    return token, hash_token(token), token[-4:]


@admin_router.get("", response_model=list[AgentOut])
async def list_agents():
    async with Session() as session:
        rows = (await session.execute(select(Agent, Device).join(Device, Device.id == Agent.device_id).order_by(Device.name))).all()
    return [_out(a, d) for a, d in rows]


@admin_router.post("", response_model=AgentToken, status_code=201)
async def create_agent(body: AgentCreate):
    """Nowy serwer z agentem. Token jest pokazywany tylko raz (w bazie zostaje skrót)."""
    token, token_hash, hint = _new_token()
    async with Session() as session, session.begin():
        # Adres zastępczy (kolumna host jest unikalna); po pierwszym raporcie zastąpi go nazwa serwera
        device = Device(
            name=body.name.strip(),
            host=f"agent-{secrets.token_hex(4)}",
            port=0,
            driver="agent",
            detected_driver="agent",
            kind="server",
            community=None,
        )
        session.add(device)
        await session.flush()
        agent = Agent(device_id=device.id, token_hash=token_hash, token_hint=hint)
        session.add(agent)
        await session.flush()
        await session.refresh(agent)
        await session.refresh(device)
    return AgentToken(agent=_out(agent, device), token=token)


@admin_router.post("/{agent_id}/token", response_model=AgentToken)
async def rotate_token(agent_id: int):
    """Nowy token – poprzedni od razu przestaje działać (np. po wycieku albo przeniesieniu agenta)."""
    token, token_hash, hint = _new_token()
    async with Session() as session, session.begin():
        agent = await session.get(Agent, agent_id)
        if agent is None:
            raise HTTPException(404, "Nie ma takiego agenta")
        agent.token_hash, agent.token_hint = token_hash, hint
        device = await session.get(Device, agent.device_id)
    return AgentToken(agent=_out(agent, device), token=token)


# --- raport agenta ----------------------------------------------------------------

Name = Annotated[str, Field(min_length=1, max_length=255)]
Short = Annotated[str, Field(max_length=64)]


class DiskIn(BaseModel):
    mount: Name
    fs: Short | None = None
    total_bytes: int = Field(ge=0)
    used_bytes: int = Field(ge=0)


class DiskIoIn(BaseModel):
    device: Short
    read_bps: float | None = None
    write_bps: float | None = None


class NetIn(BaseModel):
    iface: Short
    rx_bps: float | None = None
    tx_bps: float | None = None


class TempIn(BaseModel):
    sensor: Annotated[str, Field(min_length=1, max_length=128)]
    celsius: float


class ServiceIn(BaseModel):
    name: Name
    active: Short
    sub: Short | None = None


class ServicesIn(BaseModel):
    running: int = Field(0, ge=0)
    failed: int = Field(0, ge=0)
    # Usługi, które nie działają, i te, które użytkownik kazał obserwować (SERVICES w konfiguracji agenta)
    items: Annotated[list[ServiceIn], Field(max_length=300)] = []


class ContainerIn(BaseModel):
    name: Name
    image: Name | None = None
    state: Short
    status: Short | None = None
    cpu_percent: float | None = None
    mem_bytes: int | None = Field(None, ge=0)


class SmartIn(BaseModel):
    device: Short
    model: Annotated[str, Field(max_length=128)] | None = None
    passed: bool | None = None
    temp_c: float | None = None
    power_on_hours: int | None = None
    reallocated: int | None = None


class AgentReport(BaseModel):
    agent_version: Annotated[str, Field(max_length=32)]
    hostname: Name
    os: Annotated[str, Field(max_length=128)] | None = None
    kernel: Short | None = None
    uptime_s: float | None = None
    cpu_percent: float | None = None
    cpu_cores: Annotated[list[float], Field(max_length=512)] = []
    load: Annotated[list[float], Field(max_length=3)] = []
    mem_used_percent: float | None = None
    mem_total_bytes: int | None = Field(None, ge=0)
    swap_used_percent: float | None = None
    processes: int | None = Field(None, ge=0)
    disks: Annotated[list[DiskIn], Field(max_length=64)] = []
    disk_io: Annotated[list[DiskIoIn], Field(max_length=64)] = []
    net: Annotated[list[NetIn], Field(max_length=64)] = []
    temps: Annotated[list[TempIn], Field(max_length=128)] = []
    services: ServicesIn | None = None
    containers: Annotated[list[ContainerIn], Field(max_length=500)] | None = None
    smart: Annotated[list[SmartIn], Field(max_length=64)] | None = None


class ReportAck(BaseModel):
    accepted: bool
    interval_s: int
    server_version: str


def metric_rows(report: AgentReport, device_id: int, now: datetime) -> list[dict]:
    """Wartości, które nie mają stałych kolumn, jako wiersze ogólnej tabeli `metrics`."""
    rows: list[dict] = []

    def add(name: str, value: float | None, key: str = "") -> None:
        if value is not None:
            rows.append({"time": now, "device_id": device_id, "name": name, "key": key[:255], "value": float(value)})

    for i, pct in enumerate(report.cpu_cores):
        add("cpu_core_percent", pct, f"cpu{i}")
    if len(report.load) == 3:
        add("load5", report.load[1])
        add("load15", report.load[2])
    for d in report.disk_io:
        add("disk_read_bps", d.read_bps, d.device)
        add("disk_write_bps", d.write_bps, d.device)
    for n in report.net:
        add("net_rx_bps", n.rx_bps, n.iface)
        add("net_tx_bps", n.tx_bps, n.iface)
    for t in report.temps:
        add("temp_c", t.celsius, t.sensor)
    if report.services is not None:
        add("services_failed", report.services.failed)
        for s in report.services.items:
            add("service_up", 1.0 if s.active == "active" else 0.0, s.name)
    for c in report.containers or []:
        add("container_up", 1.0 if c.state == "running" else 0.0, c.name)
        add("container_cpu_percent", c.cpu_percent, c.name)
        add("container_mem_bytes", c.mem_bytes, c.name)
    for s in report.smart or []:
        add("smart_ok", None if s.passed is None else (1.0 if s.passed else 0.0), s.device)
        add("smart_temp_c", s.temp_c, s.device)
        add("smart_reallocated", s.reallocated, s.device)
    # Ta sama nazwa i klucz dwa razy (np. dwa czujniki o tej samej nazwie) złamałyby klucz główny
    unique = {(r["name"], r["key"]): r for r in rows}
    return list(unique.values())


def inventory(report: AgentReport) -> dict:
    """Zdjęcie stanu do panelu (lista kontenerów, usług, temperatury, SMART) – bez historii."""
    return report.model_dump(
        mode="json",
        include={"agent_version", "os", "kernel", "load", "mem_total_bytes", "temps", "services", "containers", "smart"},
    ) | {"cpu_cores": len(report.cpu_cores) or None}


def _bearer(authorization: str | None) -> str:
    scheme, _, token = (authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        raise HTTPException(401, "Brak tokenu agenta (nagłówek Authorization: Bearer …)", headers={"WWW-Authenticate": "Bearer"})
    return token.strip()


@push_router.post("/api/agent/v1/report", response_model=ReportAck)
async def agent_report(report: AgentReport, request: Request, authorization: Annotated[str | None, Header()] = None):
    token = _bearer(authorization)
    now = datetime.now(UTC)
    async with Session() as session, session.begin():
        agent = await session.scalar(select(Agent).where(Agent.token_hash == hash_token(token)).with_for_update())
        if agent is None:
            raise HTTPException(401, "Nieznany albo odwołany token agenta", headers={"WWW-Authenticate": "Bearer"})
        device = await session.get(Device, agent.device_id)
        ack = ReportAck(accepted=device.enabled, interval_s=settings.poll_interval, server_version=__version__)
        if agent.last_seen_at and now - agent.last_seen_at < MIN_REPORT_GAP:
            raise HTTPException(429, "Za częste raporty agenta", headers={"Retry-After": str(int(MIN_REPORT_GAP.total_seconds()))})
        agent.last_seen_at = now
        agent.last_ip = client_ip(request)[:64]
        agent.agent_version = report.agent_version
        agent.hostname = report.hostname
        if not device.enabled:
            return ack  # wyłączone w panelu: agent żyje, ale danych nie zbieramy

        agent.inventory = inventory(report)
        device.status, device.last_error = "up", None
        device.last_polled_at = device.last_ok_at = now
        device.vendor, device.model, device.firmware = "Linux", report.os, report.kernel
        device.sys_name, device.uptime_s, device.kind = report.hostname, report.uptime_s, "server"
        if device.host.startswith("agent-"):
            taken = await session.scalar(select(Device.id).where(Device.host == report.hostname, Device.id != device.id))
            if taken is None:
                device.host = report.hostname

        session.add(
            DeviceMetric(
                time=now,
                device_id=device.id,
                reachable=True,
                uptime_s=report.uptime_s,
                cpu_percent=report.cpu_percent,
                mem_used_percent=report.mem_used_percent,
                load1=report.load[0] if report.load else None,
            )
        )
        session.add(
            ServerMetric(time=now, device_id=device.id, swap_used_percent=report.swap_used_percent, processes=report.processes)
        )
        disks = {d.mount: d for d in report.disks}
        session.add_all(
            DiskMetric(time=now, device_id=device.id, mount=d.mount, total_bytes=d.total_bytes, used_bytes=d.used_bytes)
            for d in disks.values()
        )
        if rows := metric_rows(report, device.id, now):
            await session.execute(insert(Metric), rows)
    return ack


# --- instalacja -------------------------------------------------------------------


@push_router.get("/agent/install.sh", response_class=PlainTextResponse, include_in_schema=False)
async def install_script():
    return PlainTextResponse((AGENT_DIR / "install.sh").read_text(encoding="utf-8"), media_type="text/x-shellscript")


@push_router.get("/agent/netpulse-agent.py", response_class=PlainTextResponse, include_in_schema=False)
async def agent_program():
    source = (AGENT_DIR / "netpulse_agent.py").read_text(encoding="utf-8")
    # Agent zna wersję serwera, z którego go pobrano (do porównania w panelu)
    return PlainTextResponse(source.replace('VERSION = "dev"', f'VERSION = "{__version__}"', 1), media_type="text/x-python")
