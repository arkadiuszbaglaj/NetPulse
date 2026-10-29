"""Topologia sieci: urządzenia i połączenia między ich portami (LLDP z kontrolera UniFi).

Od 0.35.0 krawędź ma też obciążenie kabla: port z SNMP po jednej ze stron (numer portu z kontrolera → interfejs:
„0/N” na switchu, „eth(N-1)” na bramie i AP), jego prędkość i ostatni ruch (większy z kierunków).
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import distinct_on

from ..db import Session
from ..db.models import Device, Interface, InterfaceMetric, TopologyLink
from .devices import poe_port_idx
from .security import require_user

router = APIRouter(prefix="/api", tags=["topologia"], dependencies=[Depends(require_user)])


class NodeOut(BaseModel):
    id: str  # "d<id>" dla urządzenia NetPulse, "x<mac>" dla nieznanego sąsiada (np. modem na WAN)
    kind: str  # device | external
    device_id: int | None
    name: str
    device_kind: str | None  # gateway | switch | ap | other
    model: str | None
    status: str | None


class EdgeOut(BaseModel):
    a: str
    a_port: int | None
    b: str
    b_port: int | None
    # Obciążenie kabla (0.35.0): port, z którego je znamy (strona a albo b), prędkość, ruch i wykorzystanie 0–1
    interface_id: int | None = None
    device_id: int | None = None
    speed_mbps: int | None = None
    traffic_bps: float | None = None
    utilization: float | None = None


class TopologyOut(BaseModel):
    nodes: list[NodeOut]
    edges: list[EdgeOut]


def build_edges(links: list[TopologyLink]) -> list[EdgeOut]:
    """Łączy wpisy LLDP obu końców kabla w jedną krawędź (każdy koniec zna swój port)."""
    mac_to_device = {link.local_mac: link.device_id for link in links}
    pairs: dict[frozenset[str], dict[str, int | None]] = {}
    for link in links:
        a = f"d{link.device_id}"
        remote_device = mac_to_device.get(link.remote_mac)
        b = f"d{remote_device}" if remote_device is not None else f"x{link.remote_mac}"
        if a == b:
            continue
        # Kilka kabli między tymi samymi urządzeniami (LAG) łączymy w jedną krawędź z pierwszym portem
        ports = pairs.setdefault(frozenset((a, b)), {})
        if ports.get(a) is None:
            ports[a] = link.local_port_idx
    edges = []
    for key, ports in pairs.items():
        a, b = sorted(key)
        edges.append(EdgeOut(a=a, a_port=ports.get(a), b=b, b_port=ports.get(b)))
    return sorted(edges, key=lambda e: (e.a, e.b))


CURRENT = timedelta(minutes=5)


def port_interface(interfaces: list[Interface], port: int | None) -> Interface | None:
    """Interfejs SNMP dla numeru portu z kontrolera: „0/N” (switch UniFi), inaczej „eth(N-1)” (brama, AP)."""
    if port is None:
        return None
    by_name = {i.name: i for i in interfaces}
    return next((i for i in interfaces if poe_port_idx(i.name) == port), None) or by_name.get(f"eth{port - 1}")


async def add_load(session, edges: list[EdgeOut]) -> None:
    """Dopisuje do krawędzi port, jego prędkość i bieżący ruch (próbka z ostatnich minut)."""
    ids = {int(n[1:]) for e in edges for n in (e.a, e.b) if n.startswith("d")}
    if not ids:
        return
    by_device: dict[int, list[Interface]] = {}
    for iface in (await session.scalars(select(Interface).where(Interface.device_id.in_(ids)))).all():
        by_device.setdefault(iface.device_id, []).append(iface)
    found: dict[int, Interface] = {}
    for e in edges:
        for node, port in ((e.a, e.a_port), (e.b, e.b_port)):
            iface = port_interface(by_device.get(int(node[1:]), []), port) if node.startswith("d") else None
            if iface is not None:
                e.interface_id, e.device_id, e.speed_mbps = iface.id, iface.device_id, iface.speed_mbps
                found[iface.id] = iface
                break
    if not found:
        return
    latest = {
        m.interface_id: m
        for m in (
            await session.scalars(
                select(InterfaceMetric)
                .ext(distinct_on(InterfaceMetric.interface_id))
                .where(InterfaceMetric.interface_id.in_(list(found)), InterfaceMetric.time >= datetime.now(UTC) - CURRENT)
                .order_by(InterfaceMetric.interface_id, InterfaceMetric.time.desc())
            )
        ).all()
    }
    for e in edges:
        m = latest.get(e.interface_id) if e.interface_id is not None else None
        rates = [v for v in (m.in_bps, m.out_bps) if v is not None] if m else []
        if rates:
            e.traffic_bps = max(rates)
            if e.speed_mbps:
                e.utilization = min(1.0, e.traffic_bps / (e.speed_mbps * 1e6))


@router.get("/topology", response_model=TopologyOut)
async def topology():
    """Mapa sieci: pusta, dopóki żaden kontroler UniFi nie podał tablic LLDP."""
    async with Session() as session:
        links = list((await session.scalars(select(TopologyLink))).all())
        devices = {d.id: d for d in (await session.scalars(select(Device).where(Device.enabled))).all()}
        links = [link for link in links if link.device_id in devices]
        edges = build_edges(links)
        await add_load(session, edges)
    used = {e.a for e in edges} | {e.b for e in edges}
    nodes: list[NodeOut] = []
    for dev_id, d in sorted(devices.items()):
        if f"d{dev_id}" in used:  # urządzenia bez żadnego połączenia nie trafiają na mapę
            nodes.append(
                NodeOut(
                    id=f"d{dev_id}",
                    kind="device",
                    device_id=dev_id,
                    name=d.name,
                    device_kind=d.kind,
                    model=d.model,
                    status=d.status,
                )
            )
    for node_id in sorted(n for n in used if n.startswith("x")):
        nodes.append(
            NodeOut(id=node_id, kind="external", device_id=None, name=node_id[1:], device_kind=None, model=None, status=None)
        )
    return TopologyOut(nodes=nodes, edges=edges)
