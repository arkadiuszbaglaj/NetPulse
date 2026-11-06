"""Okna serwisowe – czysta logika (maintenance.py): harmonogram, północ, zmiana czasu, zakres urządzeń."""

from __future__ import annotations

import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).parent.parent))

from netpulse.maintenance import Window, active, in_maintenance, spans_for  # noqa: E402

WAW = ZoneInfo("Europe/Warsaw")


def at(y, m, d, hh=0, mm=0) -> datetime:
    return datetime(y, m, d, hh, mm, tzinfo=UTC)


def weekly(days, time_from, minutes, device_ids=None, wid=1) -> Window:
    return Window(wid, "okno", frozenset(device_ids) if device_ids else None, "weekly", days=tuple(days), time_from=time_from, duration_min=minutes)


def test_once_window_is_clipped_to_range():
    w = Window(1, "fw", None, "once", starts_at=at(2026, 11, 10, 21), ends_at=at(2026, 11, 10, 23))
    assert w.occurrences(at(2026, 11, 10, 22), at(2026, 11, 11)) == [(at(2026, 11, 10, 22), at(2026, 11, 10, 23))]
    assert w.occurrences(at(2026, 11, 11), at(2026, 11, 12)) == []
    assert w.active_at(at(2026, 11, 10, 21, 30)) and not w.active_at(at(2026, 11, 10, 23))  # koniec poza oknem
    assert w.next_start(at(2026, 11, 10, 20)) == at(2026, 11, 10, 21)
    assert w.next_start(at(2026, 11, 10, 21, 30)) is None  # już trwa


def test_weekly_window_crossing_midnight_belongs_to_start_day():
    w = weekly([5], "23:00", 180)  # sobota 23:00 przez 3 h (czas polski, zimą UTC+1)
    assert w.active_at(at(2026, 11, 7, 22, 30), WAW)  # sobota 23:30
    assert w.active_at(at(2026, 11, 8, 0, 30), WAW)  # niedziela 01:30 – dalej sobotnie okno
    assert not w.active_at(at(2026, 11, 8, 1, 0), WAW)  # niedziela 02:00 – koniec
    assert w.active_until(at(2026, 11, 8, 0, 30), WAW) == at(2026, 11, 8, 1)
    assert w.next_start(at(2026, 11, 8, 0, 30), WAW) == at(2026, 11, 14, 22)


def test_weekly_window_keeps_local_hour_across_dst():
    w = weekly([5], "02:00", 60)  # sobota 02:00 czasu polskiego
    spans = w.occurrences(at(2026, 3, 27), at(2026, 4, 6), WAW)
    assert spans == [(at(2026, 3, 28, 1), at(2026, 3, 28, 2)), (at(2026, 4, 4, 0), at(2026, 4, 4, 1))]  # UTC+1, potem UTC+2


def test_scope_and_merged_spans():
    switch_only = weekly([0, 1, 2, 3, 4, 5, 6], "02:00", 120, device_ids=[2])
    everything = Window(2, "prąd", None, "once", starts_at=at(2026, 11, 10, 2), ends_at=at(2026, 11, 10, 4))
    assert switch_only.covers(2) and not switch_only.covers(3) and not switch_only.covers(None)
    assert everything.covers(3) and everything.covers(None)  # okno na wszystko obejmuje też alerty bez urządzenia

    now = at(2026, 11, 10, 1, 30)  # 02:30 czasu polskiego
    running = active([switch_only, everything], now, WAW)
    assert [w.id for w in running] == [1]
    assert in_maintenance(running, 2) and not in_maintenance(running, 3)

    # Nakładające się przedziały scalone: 01:00–03:00 UTC (switch) + 02:00–04:00 UTC (wszystko) = 01:00–04:00
    merged = spans_for([switch_only, everything], 2, at(2026, 11, 10), at(2026, 11, 10, 12), WAW)
    assert merged == [(at(2026, 11, 10, 1), at(2026, 11, 10, 4))]
    assert spans_for([switch_only, everything], 3, at(2026, 11, 10), at(2026, 11, 10, 12), WAW) == [(at(2026, 11, 10, 2), at(2026, 11, 10, 4))]


def test_week_long_window_found_from_the_middle():
    w = weekly([0], "00:00", 7 * 24 * 60)  # cały tydzień od poniedziałku
    assert w.active_at(at(2026, 11, 14, 12), WAW)  # sobota
    assert w.occurrences(at(2026, 11, 14), at(2026, 11, 14) + timedelta(hours=1), WAW)
