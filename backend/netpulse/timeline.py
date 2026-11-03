"""Zdarzenia chwilowe: restarty urządzeń i przełączenia łączy WAN – dla kafelka „Zdarzenia” (api/events.py)
i alertów „Restart urządzenia” / „Przełączenie WAN” (alerts.py).

Restart = spadek `uptime_s` między kolejnymi próbkami urządzenia; czas restartu to chwila próbki minus nowy uptime.
Przełączenie WAN liczy `wan.switches` z próbek łączy (ta sama logika co historia łączy)."""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import select, text

from . import wan_links
from .db.models import WanLink, WanLinkMetric
from .wan import Sample, switches

_RESTARTS_SQL = text(
    """
    SELECT device_id, time, uptime_s FROM (
        SELECT device_id, time, uptime_s,
               LAG(uptime_s) OVER (PARTITION BY device_id ORDER BY time) AS prev
        FROM device_metrics
        WHERE device_id = ANY(:ids) AND uptime_s IS NOT NULL AND time >= :before AND time < :until
    ) s
    WHERE prev IS NOT NULL AND uptime_s < prev AND time >= :since
    """
)


@dataclass(frozen=True)
class Restart:
    device_id: int
    time: datetime  # chwila restartu (próbka minus uptime)
    detected: datetime  # próbka, w której uptime spadł – stała, nadaje się na klucz alertu
    uptime_s: float


@dataclass(frozen=True)
class WanSwitch:
    time: datetime
    from_names: str
    to_names: str
    device_id: int  # router łącza, które przejęło ruch


async def restarts(session, device_ids: Iterable[int], since: datetime, until: datetime) -> list[Restart]:
    ids = list(device_ids)
    if not ids:
        return []
    rows = await session.execute(_RESTARTS_SQL, {"ids": ids, "before": since - timedelta(hours=1), "since": since, "until": until})
    return [
        Restart(device_id, max(since, t - timedelta(seconds=float(uptime))), t, float(uptime)) for device_id, t, uptime in rows
    ]


def _names(ids, names: dict[int, str]) -> str:
    return " + ".join(names.get(i, f"#{i}") for i in ids)


async def wan_switches(session, device_ids: Iterable[int], since: datetime, until: datetime) -> list[WanSwitch]:
    """Przełączenia ruchu między łączami WAN routerów `device_ids` (kolejność łączy wspólna dla routerów)."""
    links = (await session.scalars(select(WanLink).where(WanLink.device_id.in_(list(device_ids) or [0])))).all()
    if not links:
        return []
    names = {x.id: x.name for x in links}
    owner = {x.id: x.device_id for x in links}
    rows = await session.execute(
        select(WanLinkMetric.wan_link_id, WanLinkMetric.time, WanLinkMetric.up, WanLinkMetric.active)
        .where(WanLinkMetric.wan_link_id.in_(list(names)), WanLinkMetric.time >= since, WanLinkMetric.time < until)
        .order_by(WanLinkMetric.time)
    )
    samples: dict[int, list[Sample]] = defaultdict(list)
    for link_id, t, up, active in rows:
        samples[link_id].append(Sample(t, up, active))
    return [
        WanSwitch(sw.time, _names(sw.from_ids, names), _names(sw.to_ids, names), owner[sw.to_ids[0]])
        for sw in switches(samples, wan_links.stale_after())
    ]
