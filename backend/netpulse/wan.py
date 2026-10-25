"""Łącza WAN routera (dual WAN / failover): które łącze jest sprawne, którym idzie ruch, historia i SLA.

Skąd wiadomo, że łącze działa i jest w użyciu (szczegóły: docs/19-dual-wan.md):
1. Sprawne (`up`): port ma link (`ifOperStatus` = up z SNMP), a kontroler UniFi – jeśli coś o nim wie –
   nie zgłasza awarii (UniFi sprawdza też, czy przez łącze jest internet).
2. W użyciu (`active`): najpierw informacja z kontrolera UniFi (port oznaczony jako uplink bramy). Bez kontrolera
   decyduje ruch: jedno sprawne łącze jest aktywne zawsze; z kilku sprawnych aktywne jest to, którym idzie ruch
   (łącze zapasowe w trybie failover przenosi tylko pingi kontrolne). Przy znikomym ruchu na wszystkich łączach
   zostaje poprzednio aktywne.

Funkcje są czyste (bez bazy) – kolektor i API tylko podają im dane.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta

# Ruch, od którego łącze uznajemy za używane (pingi kontrolne łącza zapasowego są dużo mniejsze)
ACTIVE_MIN_BPS = 50_000.0
# Przy równoważeniu obciążenia aktywne są wszystkie łącza z co najmniej takim udziałem w ruchu najbardziej obciążonego
ACTIVE_SHARE = 0.2

STATES = ("active", "standby", "down", "unknown")


@dataclass(frozen=True)
class LinkReading:
    """Odczyt jednego łącza w cyklu kolektora."""

    link_id: int
    position: int
    oper_up: bool | None  # None = brak interfejsu w odczycie SNMP
    in_bps: float | None = None
    out_bps: float | None = None
    ctrl_up: bool | None = None  # co mówi kontroler UniFi (None = nie wie albo dane nieświeże)
    ctrl_active: bool | None = None
    prev_state: str = "unknown"

    @property
    def traffic(self) -> float:
        return (self.in_bps or 0.0) + (self.out_bps or 0.0)


@dataclass(frozen=True)
class LinkDecision:
    link_id: int
    up: bool
    active: bool
    state: str  # active | standby | down | unknown
    source: str | None  # controller | traffic | None (nie było czego rozstrzygać)


def _state(r: LinkReading, up: bool, active: bool) -> str:
    if r.oper_up is None:
        return "unknown"
    return "active" if active else "standby" if up else "down"


def _by_traffic(ups: list[LinkReading]) -> set[int]:
    if len(ups) == 1:
        return {ups[0].link_id}
    top = max(r.traffic for r in ups)
    if top >= ACTIVE_MIN_BPS:
        floor = max(ACTIVE_MIN_BPS, top * ACTIVE_SHARE)
        return {r.link_id for r in ups if r.traffic >= floor}
    # Cisza na wszystkich łączach: zostaje poprzednio aktywne, a bez niego – pierwsze w kolejności
    previous = {r.link_id for r in ups if r.prev_state == "active"}
    return previous or {min(ups, key=lambda r: r.position).link_id}


def decide(readings: Sequence[LinkReading]) -> dict[int, LinkDecision]:
    """Stan łączy jednego routera w jednym cyklu."""
    up = {r.link_id: bool(r.oper_up) and r.ctrl_up is not False for r in readings}
    ups = [r for r in readings if up[r.link_id]]
    active: set[int] = set()
    source: str | None = None
    if any(r.ctrl_active is not None for r in readings):
        active = {r.link_id for r in ups if r.ctrl_active}
        source = "controller"
    if not active and ups:
        # Kontroler milczy albo wskazał łącze, które według SNMP nie ma linku – decyduje ruch
        active = _by_traffic(ups)
        source = "traffic"
    return {
        r.link_id: LinkDecision(
            link_id=r.link_id,
            up=up[r.link_id],
            active=r.link_id in active,
            state=_state(r, up[r.link_id], r.link_id in active),
            source=source,
        )
        for r in readings
    }


# --- historia i SLA -------------------------------------------------------------------------------


@dataclass(frozen=True)
class Sample:
    time: datetime
    up: bool
    active: bool

    @property
    def state(self) -> str:
        return "active" if self.active else "standby" if self.up else "down"


@dataclass(frozen=True)
class Segment:
    """Odcinek czasu w jednym stanie; przerwa w danych dłuższa niż `max_gap` kończy odcinek."""

    state: str
    start: datetime
    end: datetime

    @property
    def seconds(self) -> float:
        return (self.end - self.start).total_seconds()


def segments(samples: Iterable[Sample], start: datetime, end: datetime, max_gap: timedelta) -> list[Segment]:
    """Próbka obowiązuje do następnej, ale najdłużej `max_gap` (dalej brak danych). Wynik przycięty do [start, end]."""
    items = sorted(samples, key=lambda s: s.time)
    out: list[Segment] = []
    for i, s in enumerate(items):
        until = s.time + max_gap
        if i + 1 < len(items):
            until = min(until, items[i + 1].time)
        a, b = max(s.time, start), min(until, end)
        if b <= a:
            continue
        last = out[-1] if out else None
        if last and last.state == s.state and last.end == a:
            out[-1] = Segment(s.state, last.start, b)
        else:
            out.append(Segment(s.state, a, b))
    return out


@dataclass(frozen=True)
class Outage:
    start: datetime
    end: datetime
    ongoing: bool

    @property
    def seconds(self) -> float:
        return (self.end - self.start).total_seconds()


@dataclass
class Sla:
    up_s: float = 0.0
    down_s: float = 0.0
    active_s: float = 0.0
    unknown_s: float = 0.0
    outages: list[Outage] = field(default_factory=list)

    @property
    def availability(self) -> float | None:
        """Dostępność w % czasu, dla którego są dane (None = brak danych)."""
        known = self.up_s + self.down_s
        return round(100.0 * self.up_s / known, 3) if known > 0 else None

    @property
    def longest_s(self) -> float:
        return max((o.seconds for o in self.outages), default=0.0)


def compute_sla(samples: Iterable[Sample], start: datetime, end: datetime, max_gap: timedelta) -> Sla:
    """Dostępność łącza w okresie: czas sprawności, awarii, w użyciu, bez danych i lista przerw.

    Przerwa to ciągły odcinek awarii; brak danych (np. router nie odpowiadał) nie jest liczony ani jako
    dostępność, ani jako przerwa."""
    items = sorted(samples, key=lambda s: s.time)
    segs = segments(items, start, end, max_gap)
    sla = Sla()
    for seg in segs:
        if seg.state == "down":
            sla.down_s += seg.seconds
            prev = sla.outages[-1] if sla.outages else None
            if prev and prev.end == seg.start:
                sla.outages[-1] = Outage(prev.start, seg.end, False)
            else:
                sla.outages.append(Outage(seg.start, seg.end, False))
        else:
            sla.up_s += seg.seconds
            if seg.state == "active":
                sla.active_s += seg.seconds
    sla.unknown_s = max(0.0, (end - start).total_seconds() - sla.up_s - sla.down_s)
    # Przerwa trwa nadal, jeśli ostatnia próbka mówi o awarii i jest świeża
    if sla.outages and items and items[-1].state == "down" and end - items[-1].time <= max_gap:
        last = sla.outages[-1]
        if last.end >= items[-1].time:
            sla.outages[-1] = Outage(last.start, last.end, True)
    return sla


@dataclass(frozen=True)
class Switch:
    """Zmiana łącza, którym idzie ruch (np. awaria WAN 1 → ruch przejmuje WAN 2)."""

    time: datetime
    from_ids: tuple[int, ...]
    to_ids: tuple[int, ...]


def switches(samples: dict[int, Iterable[Sample]]) -> list[Switch]:
    """Momenty przełączenia ruchu między łączami jednego routera (próbki łączy mają wspólne znaczniki czasu cyklu)."""
    by_time: dict[datetime, set[int]] = {}
    for link_id, items in samples.items():
        for s in items:
            active = by_time.setdefault(s.time, set())
            if s.active:
                active.add(link_id)
    out: list[Switch] = []
    previous: set[int] | None = None
    for t in sorted(by_time):
        current = by_time[t]
        if not current:
            continue  # żadne łącze nie działa – przełączenie liczymy dopiero, gdy ruch gdzieś wróci
        if previous is not None and current != previous:
            out.append(Switch(t, tuple(sorted(previous)), tuple(sorted(current))))
        previous = current
    return out
