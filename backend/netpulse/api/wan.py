"""Łącza WAN routera (dual WAN / failover): stan, historia (które łącze niosło ruch), SLA i konfiguracja.

- GET /api/wan/status – łącza i ich bieżący stan (active | standby | down | unknown), ruch, od kiedy w tym stanie,
- GET /api/wan/history?minutes= – ruch aktywnego łącza w kubełkach, odcinki stanów i momenty przełączenia,
- GET /api/wan/sla?days= – dostępność w %, czas i liczba przerw dla każdego łącza,
- GET/PUT /api/wan/links – które porty są WAN 1, WAN 2 … (zapis: administrator).
"""

from __future__ import annotations

from collections import defaultdict
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import delete, select, text

from .. import wan_links
from ..db import Session
from ..db.models import Device, Interface, WanLink, WanLinkMetric
from ..wan import Sample, compute_sla, segments, switches
from .metrics import MinutesQuery, _bucket_seconds
from .schemas import Point
from .security import require_admin, require_user

router = APIRouter(prefix="/api/wan", tags=["łącza WAN"], dependencies=[Depends(require_user)])

CURRENT_WINDOW = timedelta(minutes=5)
MAX_OUTAGES = 20


class WanLinkOut(BaseModel):
    id: int
    name: str
    position: int
    device_id: int
    device_name: str
    interface_id: int
    interface_name: str
    interface_label: str
    speed_mbps: int | None
    state: str  # active | standby | down | unknown
    state_since: datetime | None
    source: str | None  # controller | traffic
    in_bps: float | None = None
    out_bps: float | None = None
    sampled_at: datetime | None = None


class WanStatusOut(BaseModel):
    links: list[WanLinkOut]
    active_ids: list[int]


async def _links(session) -> list[WanLinkOut]:
    rows = (
        await session.execute(
            select(WanLink, Device.name, Interface)
            .join(Device, Device.id == WanLink.device_id)
            .join(Interface, Interface.id == WanLink.interface_id)
            .order_by(Device.name, WanLink.device_id, WanLink.position)
        )
    ).all()
    return [
        WanLinkOut(
            id=link.id,
            name=link.name,
            position=link.position,
            device_id=link.device_id,
            device_name=device_name,
            interface_id=iface.id,
            interface_name=iface.name,
            interface_label=iface.label,
            speed_mbps=iface.speed_mbps,
            state=link.state,
            state_since=link.state_since,
            source=link.source,
        )
        for link, device_name, iface in rows
    ]


@router.get("/status", response_model=WanStatusOut)
async def status():
    since = datetime.now(UTC) - CURRENT_WINDOW
    async with Session() as session:
        links = await _links(session)
        if links:
            latest = (
                select(WanLinkMetric.wan_link_id, WanLinkMetric.time, WanLinkMetric.in_bps, WanLinkMetric.out_bps)
                .distinct(WanLinkMetric.wan_link_id)
                .where(WanLinkMetric.wan_link_id.in_([x.id for x in links]), WanLinkMetric.time >= since)
                .order_by(WanLinkMetric.wan_link_id, WanLinkMetric.time.desc())
            )
            last = {r.wan_link_id: r for r in await session.execute(latest)}
            for x in links:
                if x.id in last:
                    x.in_bps, x.out_bps, x.sampled_at = last[x.id].in_bps, last[x.id].out_bps, last[x.id].time
                elif x.state != "unknown":
                    x.state = "unknown"  # brak świeżych próbek (np. kolektor nie działa)
    return WanStatusOut(links=links, active_ids=[x.id for x in links if x.state == "active"])


# --- historia ------------------------------------------------------------------------------------


class SegmentOut(BaseModel):
    link_id: int
    state: str
    start: datetime
    end: datetime


class SwitchOut(BaseModel):
    time: datetime
    from_ids: list[int]
    to_ids: list[int]


class WanHistoryOut(BaseModel):
    interval_s: int
    links: list[WanLinkOut]
    # Wartości `in_<id>` / `out_<id>`: ruch łącza tylko wtedy, gdy było aktywne (inaczej brak) – linia
    # łącza zapasowego zaczyna się w chwili przełączenia
    points: list[Point]
    segments: list[SegmentOut]
    switches: list[SwitchOut]


_HISTORY_SQL = text(
    """
    SELECT date_bin(CAST(:stride AS interval), time, TIMESTAMPTZ '2000-01-01 00:00:00+00') AS bucket, wan_link_id,
           AVG(in_bps) FILTER (WHERE active) AS in_bps, AVG(out_bps) FILTER (WHERE active) AS out_bps
    FROM wan_link_metrics
    WHERE wan_link_id = ANY(:ids) AND time >= :since
    GROUP BY bucket, wan_link_id
    ORDER BY bucket
    """
)


async def _samples(session, ids: list[int], since: datetime) -> dict[int, list[Sample]]:
    rows = await session.execute(
        select(WanLinkMetric.wan_link_id, WanLinkMetric.time, WanLinkMetric.up, WanLinkMetric.active)
        .where(WanLinkMetric.wan_link_id.in_(ids), WanLinkMetric.time >= since)
        .order_by(WanLinkMetric.time)
    )
    out: dict[int, list[Sample]] = defaultdict(list)
    for link_id, t, up, active in rows:
        out[link_id].append(Sample(t, up, active))
    return out


@router.get("/history", response_model=WanHistoryOut)
async def history(minutes: int = MinutesQuery):
    stride = _bucket_seconds(minutes)
    now = datetime.now(UTC)
    since = now - timedelta(minutes=minutes)
    max_gap = wan_links.stale_after()
    async with Session() as session:
        links = await _links(session)
        ids = [x.id for x in links]
        if not ids:
            return WanHistoryOut(interval_s=stride, links=[], points=[], segments=[], switches=[])
        rows = (await session.execute(_HISTORY_SQL, {"stride": timedelta(seconds=stride), "since": since, "ids": ids})).all()
        samples = await _samples(session, ids, since - max_gap)

    buckets: dict[datetime, dict[str, float | None]] = {}
    for bucket, link_id, in_bps, out_bps in rows:
        values = buckets.setdefault(bucket, {f"{d}_{i}": None for i in ids for d in ("in", "out")})
        values[f"in_{link_id}"] = float(in_bps) if in_bps is not None else None
        values[f"out_{link_id}"] = float(out_bps) if out_bps is not None else None
    segs = [
        SegmentOut(link_id=link_id, state=s.state, start=s.start, end=s.end)
        for link_id, items in samples.items()
        for s in segments(items, since, now, max_gap)
    ]
    by_device: dict[int, dict[int, list[Sample]]] = defaultdict(dict)
    for x in links:
        by_device[x.device_id][x.id] = [s for s in samples.get(x.id, []) if s.time >= since]
    events = sorted((sw for group in by_device.values() for sw in switches(group)), key=lambda sw: sw.time)
    return WanHistoryOut(
        interval_s=stride,
        links=links,
        points=[Point(time=t, values=v) for t, v in sorted(buckets.items())],
        segments=segs,
        switches=[SwitchOut(time=sw.time, from_ids=list(sw.from_ids), to_ids=list(sw.to_ids)) for sw in events],
    )


# --- SLA -----------------------------------------------------------------------------------------


class OutageOut(BaseModel):
    start: datetime
    end: datetime
    duration_s: float
    ongoing: bool


class LinkSlaOut(BaseModel):
    link: WanLinkOut
    availability: float | None  # % czasu z danymi, w którym łącze działało
    up_s: float
    down_s: float
    active_s: float  # ile czasu łącze niosło ruch
    unknown_s: float  # brak danych (router nie odpowiadał, kolektor nie działał)
    outages: int
    longest_outage_s: float
    recent_outages: list[OutageOut]  # najnowsze na początku


class WanSlaOut(BaseModel):
    days: int
    start: datetime
    end: datetime
    links: list[LinkSlaOut]


@router.get("/sla", response_model=WanSlaOut)
async def sla(days: int = Query(1, ge=1, le=90, description="okres wstecz w dniach (np. 1, 7, 30)")):
    end = datetime.now(UTC)
    start = end - timedelta(days=days)
    max_gap = wan_links.stale_after()
    async with Session() as session:
        links = await _links(session)
        samples = await _samples(session, [x.id for x in links], start - max_gap) if links else {}
    out = []
    for x in links:
        r = compute_sla(samples.get(x.id, []), start, end, max_gap)
        out.append(
            LinkSlaOut(
                link=x,
                availability=r.availability,
                up_s=round(r.up_s, 1),
                down_s=round(r.down_s, 1),
                active_s=round(r.active_s, 1),
                unknown_s=round(r.unknown_s, 1),
                outages=len(r.outages),
                longest_outage_s=round(r.longest_s, 1),
                recent_outages=[
                    OutageOut(start=o.start, end=o.end, duration_s=round(o.seconds, 1), ongoing=o.ongoing)
                    for o in reversed(r.outages[-MAX_OUTAGES:])
                ],
            )
        )
    return WanSlaOut(days=days, start=start, end=end, links=out)


# --- konfiguracja ----------------------------------------------------------------------------------


class WanLinkIn(BaseModel):
    interface_id: int = Field(ge=1)
    name: str = Field(min_length=1, max_length=64)

    @field_validator("name")
    @classmethod
    def _strip(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Podaj nazwę łącza")
        return v


class WanLinksIn(BaseModel):
    """Pełna lista łączy w kolejności (pierwsze = WAN 1). Pominięte łącza są usuwane razem z historią."""

    links: list[WanLinkIn] = Field(max_length=wan_links.MAX_LINKS * 4)

    @model_validator(mode="after")
    def _unique(self) -> WanLinksIn:
        ids = [x.interface_id for x in self.links]
        if len(set(ids)) != len(ids):
            raise ValueError("Ten sam port nie może być dwoma łączami WAN")
        return self


@router.get("/links", response_model=list[WanLinkOut])
async def list_links():
    async with Session() as session:
        return await _links(session)


@router.put("/links", response_model=list[WanLinkOut], dependencies=[Depends(require_admin)])
async def save_links(body: WanLinksIn):
    async with Session() as session, session.begin():
        ifaces = {
            i.id: i
            for i in (await session.scalars(select(Interface).where(Interface.id.in_([x.interface_id for x in body.links] or [0])))).all()
        }
        missing = [x.interface_id for x in body.links if x.interface_id not in ifaces]
        if missing:
            raise HTTPException(422, f"Nie ma portu o id {missing[0]}")
        per_device: dict[int, int] = defaultdict(int)
        for x in body.links:
            per_device[ifaces[x.interface_id].device_id] += 1
        if any(n > wan_links.MAX_LINKS for n in per_device.values()):
            raise HTTPException(422, f"Router może mieć najwyżej {wan_links.MAX_LINKS} łącza WAN")

        existing = {link.interface_id: link for link in (await session.scalars(select(WanLink))).all()}
        keep = {x.interface_id for x in body.links}
        await session.execute(delete(WanLink).where(WanLink.interface_id.not_in(keep or {0})))
        position: dict[int, int] = defaultdict(int)
        for x in body.links:
            device_id = ifaces[x.interface_id].device_id
            position[device_id] += 1
            link = existing.get(x.interface_id)
            if link is None:
                session.add(WanLink(device_id=device_id, interface_id=x.interface_id, position=position[device_id], name=x.name, state="unknown"))
            else:
                link.name, link.position = x.name, position[device_id]
        # Od teraz porty WAN wybiera użytkownik – kolektor nie dopisze już sam portów z rolą WAN
        await wan_links.set_manual(session)
    async with Session() as session:
        return await _links(session)
