"""Łącza WAN w bazie: konfiguracja (które porty są WAN 1, WAN 2 …), zapis stanu w cyklu kolektora i dane z kontrolera.

Logika „sprawne / w użyciu” jest w wan.py; tu tylko odczyt i zapis (wywoływane w transakcji kolektora).
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import datetime, timedelta

from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert

from .config import settings
from .db.models import AppSetting, Interface, WanLink, WanLinkMetric
from .drivers import PollResult
from .wan import LinkReading, decide

# Ustawienie instalacji: {"manual": true} po pierwszym zapisie łączy w panelu – od tej chwili kolektor
# nie dodaje już sam portów z rolą WAN (użytkownik mógł któryś celowo usunąć)
SETTINGS_KEY = "wan"
MAX_LINKS = 4
# Porty WAN bramy według kontrolera UniFi (`wan_detected:<id routera>`) – podpowiedź w Ustawienia → Łącza WAN,
# gdy kontroler zna łącze, którego nie ma na liście (np. nowy internet mobilny jako WAN 2)
DETECTED_PREFIX = "wan_detected:"


def stale_after() -> timedelta:
    """Jak długo ważna jest informacja z kontrolera i jak długo obowiązuje próbka (dłużej = brak danych)."""
    return timedelta(seconds=max(90, settings.poll_interval * 3))


async def configured(session, dev_id: int) -> dict[int, str]:
    """Porty routera ustawione jako WAN: {ifIndex: nazwa łącza}."""
    rows = await session.execute(
        select(Interface.if_index, WanLink.name)
        .join(WanLink, WanLink.interface_id == Interface.id)
        .where(WanLink.device_id == dev_id)
    )
    return {r.if_index: r.name for r in rows}


async def is_manual(session) -> bool:
    row = await session.get(AppSetting, SETTINGS_KEY)
    return bool(row and (row.value or {}).get("manual"))


async def set_manual(session) -> None:
    stmt = insert(AppSetting).values(key=SETTINGS_KEY, value={"manual": True})
    await session.execute(stmt.on_conflict_do_update(index_elements=[AppSetting.key], set_={"value": stmt.excluded.value}))


async def _auto_links(session, dev_id: int, result: PollResult, if_ids: dict[int, int]) -> list[WanLink]:
    """Pierwsza konfiguracja: porty, które driver rozpoznał jako WAN (np. eth4 na UCG Ultra), stają się WAN 1, WAN 2 …

    Kolejność jest wspólna dla wszystkich routerów – łącza kolejnego routera dostają następne numery."""
    if await is_manual(session):
        return []
    wans = sorted(i.if_index for i in result.interfaces if i.role == "wan" and i.if_index in if_ids)[:MAX_LINKS]
    last = await session.scalar(select(func.coalesce(func.max(WanLink.position), 0)))
    links = [
        WanLink(device_id=dev_id, interface_id=if_ids[idx], position=n, name=f"WAN {n}", state="unknown")
        for n, idx in enumerate(wans, start=last + 1)
    ]
    session.add_all(links)
    await session.flush()
    return links


async def _best_elsewhere(session, dev_id: int, fresh: datetime) -> int | None:
    """Pozycja najważniejszego działającego łącza na innych routerach (stan z ich ostatniego, świeżego cyklu)."""
    return await session.scalar(
        select(func.min(WanLink.position)).where(
            WanLink.device_id != dev_id, WanLink.state.in_(("active", "standby")), WanLink.updated_at >= fresh
        )
    )


async def record(
    session, dev_id: int, now: datetime, result: PollResult, if_rates: dict[int, dict], if_ids: dict[int, int]
) -> list[WanLink]:
    """Stan łączy WAN routera w tym cyklu: próbka do `wan_link_metrics` i bieżący stan w `wan_links`."""
    links = list((await session.scalars(select(WanLink).where(WanLink.device_id == dev_id).order_by(WanLink.position))).all())
    if not links:
        links = await _auto_links(session, dev_id, result, if_ids)
        if not links:
            return []
    by_id = {v: k for k, v in if_ids.items()}  # id interfejsu → ifIndex
    samples = {i.if_index: i for i in result.interfaces}
    fresh = now - stale_after()
    readings = []
    for link in links:
        idx = by_id.get(link.interface_id)
        sample = samples.get(idx) if idx is not None else None
        rates = if_rates.get(idx, {}) if idx is not None else {}
        ctrl_ok = link.ctrl_at is not None and link.ctrl_at >= fresh
        readings.append(
            LinkReading(
                link_id=link.id,
                position=link.position,
                oper_up=None if sample is None else sample.oper_status == "up",
                in_bps=rates.get("in_bps"),
                out_bps=rates.get("out_bps"),
                ctrl_up=link.ctrl_up if ctrl_ok else None,
                ctrl_active=link.ctrl_active if ctrl_ok else None,
                prev_state=link.state,
            )
        )
    decisions = decide(readings, await _best_elsewhere(session, dev_id, fresh))
    for link, reading in zip(links, readings, strict=True):
        d = decisions[link.id]
        if d.state != link.state or link.state_since is None:
            link.state_since = now
        link.state, link.source, link.updated_at = d.state, d.source, now
        if reading.oper_up is not None:
            session.add(
                WanLinkMetric(time=now, wan_link_id=link.id, up=d.up, active=d.active, in_bps=reading.in_bps, out_bps=reading.out_bps)
            )
    return links


async def mark_unknown(session, dev_id: int, now: datetime) -> None:
    """Router nie odpowiada – nie wiadomo, co z łączami (w SLA to brak danych, nie awaria)."""
    await session.execute(
        update(WanLink)
        .where(WanLink.device_id == dev_id, WanLink.state != "unknown")
        .values(state="unknown", state_since=now, updated_at=now)
    )


async def apply_controller(session, dev_id: int, wans: Iterable, now: datetime) -> int:
    """Zapisuje przy łączach WAN routera, co mówi kontroler UniFi (`wans`: porty z nazwą interfejsu, up, active).

    Łącze, którego kontroler nie zna, nie jest według niego uplinkiem, o ile kontroler wskazał jakikolwiek."""
    info = {w.ifname: w for w in wans}
    if not info:
        return 0
    any_active = any(w.active for w in info.values())
    rows = (
        await session.execute(
            select(WanLink.id, Interface.name).join(Interface, Interface.id == WanLink.interface_id).where(WanLink.device_id == dev_id)
        )
    ).all()
    for link_id, ifname in rows:
        w = info.get(ifname)
        await session.execute(
            update(WanLink)
            .where(WanLink.id == link_id)
            .values(
                ctrl_up=w.up if w else None,
                ctrl_active=(w.active if w else False) if any_active else None,
                ctrl_at=now,
            )
        )
    return len(rows)


async def save_detected(session, dev_id: int, wans: Iterable) -> None:
    """Zapamiętuje porty WAN bramy zgłoszone przez kontroler (zapis tylko przy zmianie, nie co cykl)."""
    value = {"ports": [{"ifname": w.ifname, "slot": w.slot, "up": w.up, "active": w.active} for w in wans]}
    key = f"{DETECTED_PREFIX}{dev_id}"
    row = await session.get(AppSetting, key)
    if row is not None and row.value == value:
        return
    stmt = insert(AppSetting).values(key=key, value=value)
    await session.execute(
        stmt.on_conflict_do_update(index_elements=[AppSetting.key], set_={"value": stmt.excluded.value, "updated_at": func.now()})
    )


async def detected(session) -> dict[int, list[dict]]:
    """Porty WAN zgłoszone przez kontroler: {id routera: [{ifname, slot, up, active}, …]}."""
    rows = await session.scalars(select(AppSetting).where(AppSetting.key.startswith(DETECTED_PREFIX)))
    out: dict[int, list[dict]] = {}
    for row in rows:
        suffix = row.key.removeprefix(DETECTED_PREFIX)
        if suffix.isdigit():
            out[int(suffix)] = list((row.value or {}).get("ports") or [])
    return out
