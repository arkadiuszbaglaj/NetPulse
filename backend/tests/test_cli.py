from dataclasses import replace
from datetime import UTC, datetime

from netpulse import cli


def test_fmt_time_local_zone(monkeypatch):
    monkeypatch.setattr(cli, "settings", replace(cli.settings, timezone="Europe/Warsaw"))
    # 24.10.2026 to jeszcze czas letni (UTC+2)
    assert cli._fmt_time(datetime(2026, 10, 24, 19, 51, 41, tzinfo=UTC)) == "2026-10-24 21:51:41"
    # po zmianie czasu (25.10.2026) – UTC+1
    assert cli._fmt_time(datetime(2026, 11, 2, 12, 0, 0, tzinfo=UTC)) == "2026-11-02 13:00:00"


def test_fmt_time_unknown_zone_falls_back_to_utc(monkeypatch):
    monkeypatch.setattr(cli, "settings", replace(cli.settings, timezone="Nie/Istnieje"))
    assert cli._fmt_time(datetime(2026, 10, 24, 19, 51, 41, tzinfo=UTC)) == "2026-10-24 19:51:41"


def test_fmt_time_none():
    assert cli._fmt_time(None) == "-"
