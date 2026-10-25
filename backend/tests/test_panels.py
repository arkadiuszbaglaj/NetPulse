"""Panele (0.27.0) bez bazy: odcinki stanów z kubełków."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from netpulse.api.panels import segments

T0 = datetime(2026, 10, 25, 12, 0, tzinfo=UTC)
M = timedelta(minutes=1)


def test_segments_merge_buckets_and_fill_gaps():
    buckets = [(T0, True), (T0 + M, True), (T0 + 2 * M, False), (T0 + 4 * M, True), (T0 + 5 * M, None)]
    out = [(s.start - T0, s.end - T0, s.state) for s in segments(buckets, T0, T0 + 7 * M, 60)]
    assert out == [
        (0 * M, 2 * M, "up"),
        (2 * M, 3 * M, "down"),
        (3 * M, 4 * M, "unknown"),  # brak próbek
        (4 * M, 5 * M, "up"),
        (5 * M, 7 * M, "unknown"),  # próbki bez wartości i koniec zakresu
    ]


def test_segments_clip_to_range():
    out = segments([(T0 - M, True), (T0, False)], T0 - 30 * timedelta(seconds=1), T0 + 30 * timedelta(seconds=1), 60)
    assert [(s.start, s.end, s.state) for s in out] == [(T0 - 30 * timedelta(seconds=1), T0, "up"), (T0, T0 + 30 * timedelta(seconds=1), "down")]
    assert [s.state for s in segments([], T0, T0 + M, 60)] == ["unknown"]


def test_short_gaps_keep_the_previous_state():
    buckets = [(T0, True), (T0 + 2 * M, True), (T0 + 3 * M, False), (T0 + 8 * M, False)]
    out = [(s.start - T0, s.end - T0, s.state) for s in segments(buckets, T0, T0 + 10 * M, 60, tolerance_s=120)]
    assert out == [
        (0 * M, 3 * M, "up"),  # minuta bez odczytu – dalej „działa”
        (3 * M, 4 * M, "down"),
        (4 * M, 8 * M, "unknown"),  # 4 minuty bez danych to już przerwa
        (8 * M, 10 * M, "down"),  # koniec zakresu tuż po odczycie
    ]
