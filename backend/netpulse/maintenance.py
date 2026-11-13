"""Okna serwisowe (od 0.60.0): planowane prace bez powiadomień, czas okna nie liczy się do dostępności.

Czysta logika (bez bazy): kiedy okno trwa i których urządzeń dotyczy. Okno cotygodniowe liczone w strefie czasowej
serwera (TZ) – „sobota 02:00 przez 2 h” zostaje o 02:00 także po zmianie czasu. Okno przez północ (23:00 przez 3 h)
należy do dnia, w którym się zaczyna. Zapis: tabela `maintenance_windows`, API: api/maintenance.py, użycie:
alerts.py (bez powiadomień) i api/availability.py (czas okna poza wynikiem).
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import select

from .db.models import MaintenanceWindow
from .notifications import local_tz

MAX_WEEKLY_MIN = 7 * 24 * 60  # okno cotygodniowe najwyżej tydzień
MAX_ONCE = timedelta(days=31)


@dataclass(frozen=True)
class Window:
    id: int
    name: str
    device_ids: frozenset[int] | None  # None = wszystkie urządzenia i sprawdzenia
    kind: str  # once | weekly
    starts_at: datetime | None = None
    ends_at: datetime | None = None
    days: tuple[int, ...] = ()
    time_from: str | None = None
    duration_min: int | None = None

    def covers(self, device_id: int | None) -> bool:
        """Czy okno dotyczy urządzenia; `None` = zdarzenie bez urządzenia (sprawdzenie, serwer UplinkView) – tylko okno na wszystko."""
        return self.device_ids is None or (device_id is not None and device_id in self.device_ids)

    def occurrences(self, start: datetime, end: datetime, tz: ZoneInfo | None = None) -> list[tuple[datetime, datetime]]:
        """Przedziały okna (UTC) nachodzące na [start, end), przycięte do niego."""
        return [(max(s, start), min(e, end)) for s, e in self._spans(start, end, tz)]

    def active_until(self, now: datetime, tz: ZoneInfo | None = None) -> datetime | None:
        """Koniec trwającego teraz okna; None = okno teraz nie trwa."""
        ends = [e for _, e in self._spans(now, now + timedelta(microseconds=1), tz)]
        return max(ends) if ends else None

    def active_at(self, now: datetime, tz: ZoneInfo | None = None) -> bool:
        return self.active_until(now, tz) is not None

    def next_start(self, now: datetime, tz: ZoneInfo | None = None) -> datetime | None:
        """Najbliższy początek okna po `now` (lista w panelu); None = okno jednorazowe już się zaczęło albo minęło."""
        starts = [s for s, _ in self._spans(now, now + timedelta(days=8), tz) if s > now]
        return min(starts) if starts else None

    def _spans(self, start: datetime, end: datetime, tz: ZoneInfo | None) -> list[tuple[datetime, datetime]]:
        """Pełne (nieprzycięte) przedziały okna w UTC, które nachodzą na [start, end)."""
        spans: list[tuple[datetime, datetime]] = []
        if self.kind == "once":
            if self.starts_at and self.ends_at:
                spans.append((self.starts_at, self.ends_at))
        elif self.kind == "weekly" and self.time_from and self.duration_min and self.days:
            tz = tz or local_tz()
            hh, mm = (int(x) for x in self.time_from.split(":"))
            length = timedelta(minutes=self.duration_min)
            # od dnia, w którym mogło się zacząć okno trwające jeszcze w `start`
            day: date = start.astimezone(tz).date() - timedelta(days=self.duration_min // 1440 + 1)
            last = end.astimezone(tz).date()
            while day <= last:
                if day.weekday() in self.days:
                    begins = datetime.combine(day, time(hh, mm), tzinfo=tz).astimezone(UTC)
                    spans.append((begins, begins + length))
                day += timedelta(days=1)
        return [(s, e) for s, e in spans if s < end and e > start]


def from_row(row: MaintenanceWindow) -> Window:
    ids = row.device_ids or None
    return Window(
        id=row.id,
        name=row.name,
        device_ids=frozenset(int(i) for i in ids) if ids else None,
        kind=row.kind,
        starts_at=row.starts_at,
        ends_at=row.ends_at,
        days=tuple(sorted(int(d) for d in row.days or ())),
        time_from=row.time_from,
        duration_min=row.duration_min,
    )


async def load(session) -> list[Window]:
    """Włączone okna serwisowe."""
    rows = (await session.scalars(select(MaintenanceWindow).where(MaintenanceWindow.enabled))).all()
    return [from_row(r) for r in rows]


def active(windows: Iterable[Window], now: datetime, tz: ZoneInfo | None = None) -> list[Window]:
    return [w for w in windows if w.active_at(now, tz)]


def in_maintenance(windows: Iterable[Window], device_id: int | None) -> bool:
    """Czy któreś z (trwających) okien obejmuje urządzenie."""
    return any(w.covers(device_id) for w in windows)


def spans_for(windows: Iterable[Window], device_id: int, start: datetime, end: datetime, tz: ZoneInfo | None = None) -> list[tuple[datetime, datetime]]:
    """Scalone przedziały okien obejmujących urządzenie w [start, end) – do odliczenia z dostępności."""
    spans = sorted(s for w in windows if w.covers(device_id) for s in w.occurrences(start, end, tz))
    merged: list[tuple[datetime, datetime]] = []
    for s, e in spans:
        if merged and s <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], e))
        else:
            merged.append((s, e))
    return merged
