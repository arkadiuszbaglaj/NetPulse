"""Stan serwera, na którym działa NetPulse: CPU, RAM, obciążenie, dysk, temperatura, rozmiar bazy.

Kontener czyta `/proc` i `/sys`, które pokazują wartości całego serwera (nie kontenera). Parsery są
osobnymi funkcjami na tekście, żeby dało się je testować bez prawdziwego `/proc`."""

from __future__ import annotations

import asyncio
import logging
import shutil
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import text

from .config import settings
from .db import Session
from .db.models import SystemMetric

log = logging.getLogger("netpulse.system")


@dataclass(frozen=True)
class SystemSample:
    cpu_percent: float | None = None
    load1: float | None = None
    load5: float | None = None
    load15: float | None = None
    mem_used_percent: float | None = None
    mem_total_bytes: int | None = None
    swap_used_percent: float | None = None
    disk_used_percent: float | None = None
    disk_free_bytes: int | None = None
    disk_total_bytes: int | None = None
    uptime_s: float | None = None
    temp_c: float | None = None
    db_size_bytes: int | None = None


def parse_cpu_times(stat: str) -> tuple[int, int] | None:
    """(czas bezczynności, czas łączny) z pierwszej linii `/proc/stat`."""
    for line in stat.splitlines():
        if line.startswith("cpu "):
            fields = [int(x) for x in line.split()[1:]]
            if len(fields) < 5:
                return None
            idle = fields[3] + fields[4]  # idle + iowait
            return idle, sum(fields[:8])  # bez guest, który jest już policzony w user
    return None


def cpu_percent(prev: tuple[int, int] | None, curr: tuple[int, int] | None) -> float | None:
    """Zajętość CPU między dwoma odczytami; None przy pierwszym odczycie."""
    if prev is None or curr is None:
        return None
    d_total = curr[1] - prev[1]
    if d_total <= 0:
        return None
    return round(max(0.0, min(100.0, 100.0 * (1 - (curr[0] - prev[0]) / d_total))), 1)


def parse_meminfo(text_: str) -> dict[str, int]:
    """Wartości z `/proc/meminfo` w bajtach."""
    out: dict[str, int] = {}
    for line in text_.splitlines():
        name, _, rest = line.partition(":")
        parts = rest.split()
        if parts and parts[0].isdigit():
            out[name] = int(parts[0]) * (1024 if len(parts) > 1 and parts[1] == "kB" else 1)
    return out


def memory_percent(mem: dict[str, int]) -> tuple[float | None, int | None, float | None]:
    """(RAM zajęty %, RAM razem w bajtach, swap zajęty %). „Zajęty” = bez pamięci do odzyskania (MemAvailable)."""
    total = mem.get("MemTotal")
    avail = mem.get("MemAvailable")
    ram = round(100.0 * (total - avail) / total, 1) if total and avail is not None else None
    swap_total = mem.get("SwapTotal") or 0
    swap = round(100.0 * (swap_total - mem.get("SwapFree", swap_total)) / swap_total, 1) if swap_total else None
    return ram, total, swap


def parse_loadavg(text_: str) -> tuple[float, float, float] | None:
    parts = text_.split()
    try:
        return float(parts[0]), float(parts[1]), float(parts[2])
    except (IndexError, ValueError):
        return None


def parse_uptime(text_: str) -> float | None:
    try:
        return float(text_.split()[0])
    except (IndexError, ValueError):
        return None


def read_temperature(sys_dir: Path) -> float | None:
    """Najwyższa temperatura ze stref termicznych (°C); None, gdy system jej nie udostępnia (np. maszyna wirtualna)."""
    temps = []
    for zone in sys_dir.glob("class/thermal/thermal_zone*/temp"):
        try:
            value = int(zone.read_text().strip()) / 1000
        except (OSError, ValueError):
            continue
        if 0 < value < 150:
            temps.append(value)
    return round(max(temps), 1) if temps else None


def _read(path: Path) -> str | None:
    try:
        return path.read_text()
    except OSError:
        return None


class SystemReader:
    def __init__(self, proc_dir: Path = Path("/proc"), sys_dir: Path = Path("/sys"), disk_path: str | None = None) -> None:
        self.proc_dir = proc_dir
        self.sys_dir = sys_dir
        self.disk_path = disk_path or settings.system_disk_path
        self._cpu: tuple[int, int] | None = None

    def read(self) -> SystemSample:
        stat = _read(self.proc_dir / "stat")
        now_cpu = parse_cpu_times(stat) if stat else None
        cpu = cpu_percent(self._cpu, now_cpu)
        self._cpu = now_cpu or self._cpu

        meminfo = _read(self.proc_dir / "meminfo")
        ram, mem_total, swap = memory_percent(parse_meminfo(meminfo)) if meminfo else (None, None, None)
        load = parse_loadavg(_read(self.proc_dir / "loadavg") or "")
        uptime = parse_uptime(_read(self.proc_dir / "uptime") or "")

        disk = None
        try:
            disk = shutil.disk_usage(self.disk_path)
        except OSError:
            log.debug("Brak dostępu do dysku %s", self.disk_path)
        return SystemSample(
            cpu_percent=cpu,
            load1=load[0] if load else None,
            load5=load[1] if load else None,
            load15=load[2] if load else None,
            mem_used_percent=ram,
            mem_total_bytes=mem_total,
            swap_used_percent=swap,
            disk_used_percent=round(100.0 * disk.used / disk.total, 1) if disk and disk.total else None,
            disk_free_bytes=disk.free if disk else None,
            disk_total_bytes=disk.total if disk else None,
            uptime_s=uptime,
            temp_c=read_temperature(self.sys_dir),
        )


async def database_size() -> int | None:
    try:
        async with Session() as session:
            return await session.scalar(text("SELECT pg_database_size(current_database())"))
    except Exception:
        log.debug("Nie udało się odczytać rozmiaru bazy", exc_info=True)
        return None


class SystemCollector:
    """Co cykl zapisuje próbkę stanu serwera do `system_metrics`."""

    def __init__(self, reader: SystemReader | None = None) -> None:
        self.reader = reader or SystemReader()

    async def run_forever(self) -> None:
        log.info("Kolektor stanu serwera start: interwał %ss", settings.poll_interval)
        while True:
            started = time.monotonic()
            try:
                await self.sample_once()
            except Exception:
                log.exception("Błąd odczytu stanu serwera")
            await asyncio.sleep(max(1.0, settings.poll_interval - (time.monotonic() - started)))

    async def sample_once(self) -> SystemSample:
        sample = self.reader.read()
        size = await database_size()
        async with Session() as session, session.begin():
            session.add(
                SystemMetric(
                    time=datetime.now(UTC),
                    cpu_percent=sample.cpu_percent,
                    load1=sample.load1,
                    load5=sample.load5,
                    load15=sample.load15,
                    mem_used_percent=sample.mem_used_percent,
                    mem_total_bytes=sample.mem_total_bytes,
                    swap_used_percent=sample.swap_used_percent,
                    disk_used_percent=sample.disk_used_percent,
                    disk_free_bytes=sample.disk_free_bytes,
                    disk_total_bytes=sample.disk_total_bytes,
                    uptime_s=sample.uptime_s,
                    temp_c=sample.temp_c,
                    db_size_bytes=size,
                )
            )
        return sample
