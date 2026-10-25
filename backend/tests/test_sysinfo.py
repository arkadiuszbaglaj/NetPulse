"""Stan serwera: parsery /proc i /sys oraz zapis próbek i API na prawdziwej bazie (ta część wymaga NETPULSE_TEST_DB=1)."""

from __future__ import annotations

import asyncio
import os
from pathlib import Path

import pytest

from netpulse.sysinfo import (
    SystemReader,
    cpu_percent,
    memory_percent,
    parse_cpu_times,
    parse_loadavg,
    parse_meminfo,
    parse_uptime,
    read_temperature,
)

STAT = "cpu  100 0 100 700 100 0 0 0 0 0\ncpu0 50 0 50 350 50 0 0 0 0 0\n"
STAT_LATER = "cpu  200 0 200 900 200 0 0 0 0 0\n"
MEMINFO = """MemTotal:       16000000 kB
MemFree:         1000000 kB
MemAvailable:    4000000 kB
SwapTotal:       2000000 kB
SwapFree:        1500000 kB
HugePages_Total:       0
"""


def test_cpu_percent_from_two_readings():
    first = parse_cpu_times(STAT)
    assert first == (800, 1000)  # idle + iowait, suma pól
    assert cpu_percent(None, first) is None  # pierwszy odczyt nie ma z czym porównać
    assert cpu_percent(first, parse_cpu_times(STAT_LATER)) == 40.0  # przyrost 500, z tego 300 bezczynne → 40%
    assert cpu_percent(first, first) is None  # brak upływu czasu
    assert parse_cpu_times("brak linii cpu") is None


def test_memory_and_swap_percent():
    mem = parse_meminfo(MEMINFO)
    assert mem["MemTotal"] == 16_000_000 * 1024
    ram, total, swap = memory_percent(mem)
    assert ram == 75.0 and total == 16_000_000 * 1024 and swap == 25.0
    assert memory_percent({}) == (None, None, None)
    assert memory_percent({"MemTotal": 100, "MemAvailable": 50})[2] is None  # brak swapu


def test_load_and_uptime_parsers():
    assert parse_loadavg("0.52 0.40 0.31 1/234 5678\n") == (0.52, 0.40, 0.31)
    assert parse_loadavg("") is None and parse_loadavg("a b c") is None
    assert parse_uptime("12345.67 54321.00\n") == 12345.67
    assert parse_uptime("") is None


def test_temperature_takes_hottest_valid_zone(tmp_path: Path):
    for i, raw in enumerate(["45000", "61500", "bzdura", "-5000", "999000"]):
        zone = tmp_path / "class" / "thermal" / f"thermal_zone{i}"
        zone.mkdir(parents=True)
        (zone / "temp").write_text(raw)
    assert read_temperature(tmp_path) == 61.5
    assert read_temperature(tmp_path / "pusty") is None


def test_reader_combines_files_and_survives_missing_ones(tmp_path: Path):
    proc = tmp_path / "proc"
    proc.mkdir()
    (proc / "stat").write_text(STAT)
    (proc / "meminfo").write_text(MEMINFO)
    (proc / "loadavg").write_text("1.50 1.00 0.50 1/1 1\n")
    (proc / "uptime").write_text("3600.0 100.0\n")
    reader = SystemReader(proc, tmp_path / "sys", disk_path=str(tmp_path))
    first = reader.read()
    assert first.cpu_percent is None and first.mem_used_percent == 75.0 and first.load1 == 1.5 and first.uptime_s == 3600
    assert first.disk_total_bytes and 0 <= first.disk_used_percent <= 100 and first.temp_c is None
    (proc / "stat").write_text(STAT_LATER)
    assert reader.read().cpu_percent == 40.0

    empty = SystemReader(tmp_path / "nie-ma", tmp_path / "nie-ma", disk_path=str(tmp_path / "nie-ma")).read()
    assert empty.cpu_percent is None and empty.mem_used_percent is None and empty.disk_used_percent is None


if os.environ.get("NETPULSE_TEST_DB") == "1":
    from fastapi.testclient import TestClient
    from sqlalchemy import delete, func, select

    from netpulse.api import app
    from netpulse.api.security import login_limiter
    from netpulse.db import Session, engine, init_db
    from netpulse.db.models import SystemMetric, User
    from netpulse.sysinfo import SystemCollector

    ADMIN = {"username": "admin", "password": "haslo-testowe-1"}

    def run(coro_fn):
        async def wrapper():
            try:
                return await coro_fn()
            finally:
                await engine.dispose()

        return asyncio.run(wrapper())

    @pytest.fixture
    def client(tmp_path: Path):
        async def reset():
            await init_db()
            async with Session() as s, s.begin():
                await s.execute(delete(SystemMetric))
                await s.execute(delete(User))

        run(reset)
        login_limiter._failures.clear()
        with TestClient(app) as c:
            assert c.post("/api/auth/setup", json=ADMIN).status_code == 201
            yield c
        run(reset)

    def sample(tmp_path: Path) -> None:
        proc = tmp_path / "proc"
        proc.mkdir(exist_ok=True)
        (proc / "stat").write_text(STAT)
        (proc / "meminfo").write_text(MEMINFO)
        (proc / "loadavg").write_text("1.50 1.00 0.50 1/1 1\n")
        (proc / "uptime").write_text("3600.0 100.0\n")
        collector = SystemCollector(SystemReader(proc, tmp_path / "sys", disk_path=str(tmp_path)))

        async def go():
            await collector.sample_once()
            (proc / "stat").write_text(STAT_LATER)
            await collector.sample_once()

        run(go)

    def test_no_sample_means_null(client):
        assert client.get("/api/system").json() is None
        assert client.get("/api/system/metrics").json() == []

    def test_samples_are_saved_and_served(client, tmp_path):
        sample(tmp_path)

        async def count():
            async with Session() as s:
                return await s.scalar(select(func.count()).select_from(SystemMetric))

        assert run(count) == 2
        now = client.get("/api/system").json()
        assert now["cpu_percent"] == 40.0 and now["mem_used_percent"] == 75.0 and now["load1"] == 1.5
        assert now["uptime_s"] == 3600 and now["disk_total_bytes"] and now["db_size_bytes"] and now["poll_interval_s"]
        points = client.get("/api/system/metrics", params={"minutes": 60}).json()
        assert points and points[-1]["values"]["mem_used_percent"] == 75.0

    def test_system_requires_login():
        with TestClient(app) as c:
            assert c.get("/api/system").status_code == 401
            assert c.get("/api/system/metrics").status_code == 401
