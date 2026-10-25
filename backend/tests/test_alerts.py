"""Logika ocen alertów bez bazy: warunki, czas trwania i formatowanie."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from netpulse.alerts import breaches, format_value, sustained

NOW = datetime(2026, 10, 25, 12, 0, tzinfo=UTC)


def series(values, step=30):
    """Próbki co `step` s, ostatnia w chwili NOW."""
    n = len(values)
    return [(NOW - timedelta(seconds=step * (n - 1 - i)), v) for i, v in enumerate(values)]


def test_breaches_ignores_missing_values():
    assert breaches(">", 91, 90) and not breaches(">", 90, 90) and not breaches(">", None, 90)
    assert breaches("<", 1, 5) and not breaches("<", None, 5)


def test_zero_duration_only_needs_latest_sample():
    assert sustained(series([10, 95]), NOW, 0, ">", 90, 30)
    assert not sustained(series([95, 10]), NOW, 0, ">", 90, 30)
    assert not sustained([], NOW, 0, ">", 90, 30)


def test_sustained_requires_whole_window_over_threshold():
    ten_minutes = series([95] * 21)  # 10 min próbek co 30 s
    assert sustained(ten_minutes, NOW, 600, ">", 90, 30)
    dip = series([95] * 10 + [50] + [95] * 10)
    assert not sustained(dip, NOW, 600, ">", 90, 30)
    assert not sustained(series([95] * 21 + [None]), NOW, 600, ">", 90, 30)  # brak ostatniego odczytu


def test_sustained_needs_data_covering_the_window():
    short = series([95] * 4)  # tylko 1,5 min danych
    assert not sustained(short, NOW, 600, ">", 90, 30)
    assert sustained(short, NOW, 60, ">", 90, 30)


def test_old_dip_outside_window_is_ignored():
    older_dip = series([10] + [95] * 30)  # spadek 15 min temu, okno to 5 min
    assert sustained(older_dip, NOW, 300, ">", 90, 30)


def test_format_value():
    assert format_value("cpu_percent", 93.456) == "93,5%"
    assert format_value("wan_in_bps", 850_000_000) == "850,0 Mb/s"
    assert format_value("wan_out_bps", 2_500_000_000) == "2,5 Gb/s"
    assert format_value("wan_in_bps", 120) == "120 b/s"
