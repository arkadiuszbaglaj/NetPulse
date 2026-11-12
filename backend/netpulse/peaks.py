"""Szczyt ruchu na łączach WAN (od 0.70.0): najwyższa średnia z ok. 5 sekund w każdym cyklu kolektora.

Kolektor czyta liczniki co 30 s, więc na wykresie widać średnią z pół minuty – test prędkości 455 Mb/s trwający
7 s wygląda jak ok. 100 Mb/s. Ten moduł czyta same liczniki portów WAN co sekundę (jedno małe zapytanie SNMP
na router) i pamięta najwyższą prędkość z okna `WINDOW_S`; kolektor zapisuje ją obok średniej
(`interface_metrics.in_bps_max` / `out_bps_max`).

Prędkość liczymy między *zmianami* licznika, nie między odczytami: urządzenia odświeżają liczniki SNMP co
sekundę albo co kilka sekund (UCG Ultra: ok. 1 s, zmierzone 12.11.2026), a odczyt tej samej wartości dwa razy
dałby „0, potem podwójnie”. Okno to najkrótszy odcinek między zmianami, który ma co najmniej `WINDOW_S` –
przy liczniku odświeżanym co 10 s okno samo wydłuża się do 10 s zamiast fałszować szczyt.
Dokładność: chwilę zmiany znamy z dokładnością do odstępu odczytów, więc szczyt z 5 s może odbiegać o ok. ±20 %.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections import deque
from collections.abc import Hashable
from dataclasses import dataclass

from sqlalchemy import select

from .config import settings
from .db import Session
from .db.models import NON_SNMP_DRIVERS, Device, Interface
from .rates import counter_delta, rate_factor
from .snmp import SnmpClient, SnmpError, as_int
from .snmp import oids as O

log = logging.getLogger("netpulse.peaks")

WINDOW_S = 5.0  # najkrótsze okno szczytu
KEEP_S = 60.0  # jak długo pamiętać zmiany licznika (z zapasem na liczniki odświeżane rzadko)
TARGETS_TTL = 60.0  # jak często odświeżać listę portów WAN z bazy


class PeakTracker:
    """Najwyższa prędkość (b/s) z okna ≥ `window_s` od ostatniego `take` – osobno dla każdego licznika."""

    def __init__(self, window_s: float = WINDOW_S, keep_s: float = KEEP_S) -> None:
        self.window_s = window_s
        self.keep_s = keep_s
        self._events: dict[Hashable, deque[tuple[float, int]]] = {}  # (czas zauważenia zmiany, wartość licznika)
        self._peak: dict[Hashable, float] = {}

    def add(self, key: Hashable, ts: float, octets: int | None, bits: int = 64, max_bps: float | None = None) -> None:
        if octets is None:
            return
        events = self._events.setdefault(key, deque())
        if events:
            if octets == events[-1][1]:
                return  # licznik jeszcze się nie odświeżył
            if counter_delta(events[-1][1], octets, bits) is None:
                events.clear()  # reset urządzenia – zaczynamy od nowa
        events.append((ts, octets))
        while len(events) > 2 and ts - events[0][0] > self.keep_s:
            events.popleft()
        # Najbliższa wcześniejsza zmiana odległa o co najmniej okno
        base = next((e for e in reversed(events) if ts - e[0] >= self.window_s), None)
        if base is None:
            return
        delta = counter_delta(base[1], octets, bits)
        if delta is None:
            return
        bps = delta * 8 / (ts - base[0])
        if max_bps and bps > max_bps:
            return  # ponad możliwości łącza – błąd licznika, nie szczyt
        if bps > self._peak.get(key, -1.0):
            self._peak[key] = bps

    def take(self, key: Hashable) -> float | None:
        """Szczyt od poprzedniego wywołania (None, gdy nie było pełnego okna) i początek liczenia od nowa."""
        return self._peak.pop(key, None)

    def forget(self, predicate) -> None:
        for key in [k for k in self._events if predicate(k)]:
            del self._events[key]
            self._peak.pop(key, None)


@dataclass(frozen=True)
class PeakPort:
    if_index: int
    speed_mbps: int | None
    if_type: int | None


class PeakSampler:
    """Pętla w kolektorze: co `interval` sekund liczniki portów WAN każdego routera SNMP. Kolektor odbiera szczyt
    przy zapisie próbki (`take`). `interval <= 0` wyłącza pomiar – wykresy mają wtedy samą średnią."""

    def __init__(self, client_factory, interval: float | None = None) -> None:
        self.client_factory = client_factory
        self.interval = settings.peak_interval if interval is None else interval
        self.tracker = PeakTracker()
        self._clients: dict[int, tuple[object, SnmpClient]] = {}
        self._targets: dict[int, tuple[object, tuple[PeakPort, ...]]] = {}  # urządzenie → (cel SNMP, porty WAN)
        self._targets_at = 0.0

    def take(self, device_id: int, if_index: int) -> tuple[float | None, float | None]:
        """Szczyt pobierania i wysyłania portu od poprzedniego zapisu."""
        return self.tracker.take((device_id, if_index, "in")), self.tracker.take((device_id, if_index, "out"))

    async def load_targets(self) -> dict[int, tuple[object, tuple[PeakPort, ...]]]:
        from .collector import DeviceTarget, credentials_for

        async with Session() as session:
            rows = (
                await session.execute(
                    select(Device, Interface)
                    .join(Interface, Interface.device_id == Device.id)
                    .where(
                        Device.enabled,
                        Device.driver.not_in(NON_SNMP_DRIVERS),
                        Interface.role == "wan",
                        Interface.hidden.is_(False),
                        Interface.if_index > 0,
                    )
                    .order_by(Device.id, Interface.if_index)
                )
            ).all()
        out: dict[int, tuple[object, list[PeakPort]]] = {}
        for d, i in rows:
            target = DeviceTarget(d.id, d.name, d.host, d.port, d.driver, credentials_for(d))
            out.setdefault(d.id, (target, []))[1].append(PeakPort(i.if_index, i.speed_mbps, i.if_type))
        return {dev_id: (target, tuple(ports)) for dev_id, (target, ports) in out.items()}

    async def _client(self, target) -> SnmpClient:
        cached = self._clients.get(target.id)
        if cached and cached[0] == target:
            return cached[1]
        if cached:
            await self._drop(target.id)
        client = self.client_factory(target)
        self._clients[target.id] = (target, client)
        return client

    async def _drop(self, dev_id: int) -> None:
        cached = self._clients.pop(dev_id, None)
        if cached:
            with contextlib.suppress(Exception):
                await cached[1].close()

    async def sample_device(self, target, ports: tuple[PeakPort, ...], ts: float) -> None:
        oids = [f"{O.IF_HC_IN_OCTETS}.{p.if_index}" for p in ports] + [f"{O.IF_HC_OUT_OCTETS}.{p.if_index}" for p in ports]
        try:
            client = await self._client(target)
            values = await client.get(oids)
        except (SnmpError, TimeoutError, OSError) as exc:
            log.debug("%s: brak odpowiedzi przy pomiarze szczytu – %s", target.name, exc)
            await self._drop(target.id)
            return
        for p in ports:
            limit = p.speed_mbps * 1_000_000 * rate_factor(p.if_type) if p.speed_mbps else None
            self.tracker.add((target.id, p.if_index, "in"), ts, as_int(values.get(f"{O.IF_HC_IN_OCTETS}.{p.if_index}")), 64, limit)
            self.tracker.add((target.id, p.if_index, "out"), ts, as_int(values.get(f"{O.IF_HC_OUT_OCTETS}.{p.if_index}")), 64, limit)

    async def sample(self) -> None:
        now = time.monotonic()
        if now - self._targets_at > TARGETS_TTL or not self._targets_at:
            self._targets = await self.load_targets()
            self._targets_at = now
            for dev_id in [d for d in self._clients if d not in self._targets]:
                await self._drop(dev_id)
            self.tracker.forget(lambda k: k[0] not in self._targets)
        await asyncio.gather(*(self.sample_device(t, ports, time.monotonic()) for t, ports in self._targets.values()))

    async def run_forever(self) -> None:
        if self.interval <= 0:
            log.info("Pomiar szczytu ruchu WAN wyłączony (NETPULSE_PEAK_INTERVAL=0)")
            return
        log.info("Pomiar szczytu ruchu WAN: odczyt co %ss, okno %ss", self.interval, WINDOW_S)
        while True:
            started = time.monotonic()
            try:
                await self.sample()
            except Exception:
                log.exception("Błąd pomiaru szczytu")
            await asyncio.sleep(max(0.2, self.interval - (time.monotonic() - started)))
