"""Topologia sieci: urządzenia i połączenia między ich portami (LLDP z kontrolera UniFi)."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select

from ..db import Session
from ..db.models import Device, TopologyLink
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


@router.get("/topology", response_model=TopologyOut)
async def topology():
    """Mapa sieci: pusta, dopóki żaden kontroler UniFi nie podał tablic LLDP."""
    async with Session() as session:
        links = list((await session.scalars(select(TopologyLink))).all())
        devices = {d.id: d for d in (await session.scalars(select(Device).where(Device.enabled))).all()}
    links = [link for link in links if link.device_id in devices]
    edges = build_edges(links)
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
