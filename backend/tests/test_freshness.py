"""Świeżość werdyktu kolektora: awaria urządzenia ≠ brak aktualnych danych (freshness.py)."""

from __future__ import annotations

import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from netpulse import freshness  # noqa: E402
from netpulse.config import settings  # noqa: E402
from netpulse.db.models import Check, Device  # noqa: E402

NOW = datetime(2026, 11, 6, 12, 0, tzinfo=UTC)


def test_threshold_is_several_cycles_with_floor():
    assert freshness.stale_after_s() == max(120, settings.poll_interval * 4)
    assert freshness.stale_after_s(interval_s=300) == 1200  # sprawdzenie co 5 min
    assert freshness.stale_after_s(interval_s=5) == 120


def test_live_status():
    limit = timedelta(seconds=freshness.stale_after_s())
    assert freshness.live_status("down", NOW - timedelta(seconds=10), NOW) == "down"
    assert freshness.live_status("up", NOW - limit + timedelta(seconds=1), NOW) == "up"
    assert freshness.live_status("up", NOW - limit - timedelta(seconds=1), NOW) == "unknown"
    assert freshness.live_status("up", None, NOW) == "unknown"  # nigdy nie odpytane


def test_device_and_check_properties():
    fresh = Device(status="down", last_polled_at=datetime.now(UTC))
    old = Device(status="up", last_polled_at=datetime.now(UTC) - timedelta(hours=1))
    assert (fresh.live_status, fresh.stale) == ("down", False)
    assert (old.live_status, old.stale) == ("unknown", True)

    check = Check(status="up", enabled=True, interval_s=60, last_checked_at=datetime.now(UTC) - timedelta(minutes=30))
    assert (check.live_status, check.stale) == ("unknown", True)
    waiting = Check(status="unknown", enabled=True, interval_s=60, last_checked_at=None)
    assert waiting.stale is False  # nowe sprawdzenie „czeka”, to nie nieaktualne dane
    disabled = Check(status="down", enabled=False, interval_s=60, last_checked_at=None)
    assert disabled.live_status == "down"
