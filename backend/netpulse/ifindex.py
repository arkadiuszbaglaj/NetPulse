"""Port idzie za nazwą, nie za numerem `ifIndex`.

Linux (brama UniFi, serwery, MikroTik) nadaje `ifIndex` w kolejności tworzenia interfejsów, więc po aktualizacji
firmware albo restarcie numery potrafią się przesunąć (UCG Ultra 5.1 → 6.0: zniknęły bond0/ifb0/ifb1, eth4 z 8
na 7). Wiersz `interfaces` jest kluczowany (urządzenie, ifIndex), a jego `id` trzyma historię, łącza WAN, widgety
i reguły alertów – bez przeniesienia wiersza historia `eth4` dostałaby nazwę `switch0`.

`plan` (czysta funkcja) mówi, które wiersze przenieść na nowy numer, a które odstawić (`if_index = -id`,
port nieobecny – wróci na swój wiersz, gdy znów pojawi się jego nazwa). Zmiana nazwy pod tym samym numerem
(bez przesunięcia numerów) zostaje zmianą nazwy tego samego portu, jak dotąd.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import select, update

from .db.models import Interface


@dataclass(frozen=True)
class KnownPort:
    id: int
    if_index: int
    name: str
    last_seen_at: datetime | None = None


@dataclass(frozen=True)
class Plan:
    moves: dict[int, int]  # id wiersza → nowy ifIndex
    parked: tuple[int, ...]  # id wierszy odstawionych (ich numer zajął inny port)

    def __bool__(self) -> bool:
        return bool(self.moves or self.parked)


def plan(known: Sequence[KnownPort], polled: Mapping[int, str]) -> Plan:
    """Dopasowuje odczytane interfejsy ({ifIndex: nazwa}) do zapisanych wierszy po nazwie."""
    names = Counter(n for n in polled.values() if n)
    by_index = {k.if_index: k for k in known}
    claimed: dict[int, int] = {}  # id → ifIndex
    taken: set[int] = set()  # ifIndex już przydzielone
    # 1. Ten sam numer, ta sama nazwa – bez zmian
    for idx, name in polled.items():
        row = by_index.get(idx)
        if row is not None and row.name == name:
            claimed[row.id] = idx
            taken.add(idx)
    # 2. Nazwa jednoznaczna w odczycie, a jej wiersz ma inny numer – przenosimy (najświeższy wiersz o tej nazwie)
    for idx, name in sorted(polled.items()):
        if idx in taken or not name or names[name] != 1:
            continue
        rows = [k for k in known if k.name == name and k.id not in claimed]
        if not rows:
            continue
        row = max(rows, key=lambda k: (k.last_seen_at is not None, k.last_seen_at or datetime.min, k.if_index > 0))
        claimed[row.id] = idx
        taken.add(idx)
    by_id = {k.id: k for k in known}
    moves = {i: idx for i, idx in claimed.items() if by_id[i].if_index != idx}
    # Wiersz stojący na numerze, który dostał inny port, i sam nigdzie nie przypisany – odstawiamy
    parked = tuple(
        sorted(row.id for idx in moves.values() if (row := by_index.get(idx)) is not None and row.id not in claimed)
    )
    return Plan(moves, parked)


async def follow_names(session, dev_id: int, polled: Mapping[int, str]) -> Plan:
    """Przenosi wiersze `interfaces` urządzenia tak, żeby `id` portu szło za jego nazwą. Wywołać przed upsertem."""
    rows = (
        await session.execute(
            select(Interface.id, Interface.if_index, Interface.name, Interface.last_seen_at).where(
                Interface.device_id == dev_id
            )
        )
    ).all()
    result = plan([KnownPort(r.id, r.if_index, r.name, r.last_seen_at) for r in rows], polled)
    if not result:
        return result
    # Najpierw wszystkie zmieniane na numery tymczasowe (-id, unikalne), potem na docelowe – bez konfliktu
    # z UniqueConstraint(device_id, if_index)
    for row_id in [*result.moves, *result.parked]:
        await session.execute(update(Interface).where(Interface.id == row_id).values(if_index=-row_id))
    for row_id, idx in result.moves.items():
        await session.execute(update(Interface).where(Interface.id == row_id).values(if_index=idx))
    return result
