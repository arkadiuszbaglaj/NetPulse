"""Dane na żywo dla wykresów kołowych (od 0.40.0 tylko one), co ~1,5 s przez WebSocket.

`/api/live/device?device=<id>` – jedno urządzenie SNMP: prędkość i stan (podłączony / odłączony) każdego widocznego
portu, CPU i RAM (od 0.41.0) oraz dyski serwera Linux. Odczyt tym samym driverem co w kolektorze, bez zapisu do bazy.
Dopóki ktoś jest połączony, jedno wspólne odpytywanie urządzeń, które ktoś właśnie ogląda – niezależnie od liczby
wykresów. Gdy ostatni widz odejdzie, odpytywanie się kończy i klienty SNMP są zamykane.

Agenci (wysyłają dane co 30 s) i Proxmox (liczy statystyki co ~10 s) nie mają tu nic szybszego – panel bierze
dla nich odczyty z bazy."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from urllib.parse import urlsplit

from fastapi import APIRouter, WebSocket
from sqlalchemy import select

from ..collector import DeviceTarget, credentials_for, make_client
from ..db import Session
from ..db.models import Device, Interface
from ..drivers import DRIVERS, GenericDriver
from ..rates import LiveRateTracker
from ..snmp import SnmpClient, SnmpError, as_int
from ..snmp import oids as O
from .security import allowed_hosts, user_from_request

log = logging.getLogger("netpulse.live")
router = APIRouter(tags=["na żywo"])

LIVE_INTERVAL = 1.5  # s; nie szybciej, żeby nie przeciążać urządzeń
MAX_VIEWERS = 40  # połączeń (każdy wykres kołowy portu to jedno)
TARGETS_TTL = 30.0  # jak często odświeżać listę portów
MAX_OIDS = 40  # liczników w jednym zapytaniu SNMP (duży switch = kilka zapytań)
NON_SNMP_DRIVERS = ("agent", "proxmox")


@dataclass(frozen=True)
class LivePort:
    id: int  # interfaces.id
    if_index: int
    speed_mbps: int | None


@dataclass(frozen=True)
class LiveTarget:
    device: DeviceTarget
    ports: tuple[LivePort, ...]
    driver: str = GenericDriver.name  # wykryty driver – CPU, RAM i dyski czyta tak samo jak kolektor


class LiveHub:
    def __init__(self, client_factory=make_client, interval: float = LIVE_INTERVAL, max_viewers: int = MAX_VIEWERS) -> None:
        self.client_factory = client_factory
        self.interval = interval
        self.max_viewers = max_viewers
        self.tracker = LiveRateTracker()
        self._queues: dict[asyncio.Queue[dict], int] = {}  # kolejka widza → urządzenie
        self._task: asyncio.Task | None = None
        self._clients: dict[int, tuple[DeviceTarget, SnmpClient]] = {}
        self._targets: list[LiveTarget] = []
        self._targets_at = 0.0
        self._targets_for: frozenset[int] = frozenset()

    @property
    def viewers(self) -> int:
        return len(self._queues)

    def subscribe(self, device_id: int) -> asyncio.Queue[dict] | None:
        """Kolejka próbek dla nowego widza albo None, gdy osiągnięto limit."""
        if len(self._queues) >= self.max_viewers:
            return None
        q: asyncio.Queue[dict] = asyncio.Queue(maxsize=4)
        self._queues[q] = device_id
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run())
        return q

    async def unsubscribe(self, q: asyncio.Queue[dict]) -> None:
        self._queues.pop(q, None)
        if not self._queues and self._task is not None:
            task, self._task = self._task, None
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    def _watched_devices(self) -> frozenset[int]:
        return frozenset(self._queues.values())

    # --- odpytywanie ---------------------------------------------------------------

    async def _load_targets(self, device_ids: frozenset[int]) -> list[LiveTarget]:
        """Urządzenia SNMP z `device_ids` z ich widocznymi portami (urządzenie bez portów też – ma CPU i RAM)."""
        async with Session() as session:
            devices = (
                await session.scalars(
                    select(Device)
                    .where(Device.enabled, Device.driver.not_in(NON_SNMP_DRIVERS), Device.id.in_(device_ids))
                    .order_by(Device.id)
                )
            ).all()
            ports = (
                await session.scalars(
                    select(Interface)
                    .where(Interface.device_id.in_([d.id for d in devices] or [0]), Interface.hidden.is_(False))
                    .order_by(Interface.if_index)
                )
            ).all()
        by_device: dict[int, list[LivePort]] = {}
        for p in ports:
            by_device.setdefault(p.device_id, []).append(LivePort(p.id, p.if_index, p.speed_mbps))
        return [
            LiveTarget(
                DeviceTarget(d.id, d.name, d.host, d.port, d.driver, credentials_for(d)),
                tuple(by_device.get(d.id, [])),
                d.detected_driver if d.detected_driver in DRIVERS else GenericDriver.name,
            )
            for d in devices
        ]

    async def _client(self, target: DeviceTarget) -> SnmpClient:
        cached = self._clients.get(target.id)
        if cached and cached[0] == target:
            return cached[1]
        if cached:
            await cached[1].close()
        client = self.client_factory(target)
        self._clients[target.id] = (target, client)
        return client

    async def _drop(self, dev_id: int) -> None:
        cached = self._clients.pop(dev_id, None)
        if cached:
            with contextlib.suppress(Exception):
                await cached[1].close()

    async def _sample_device(self, target: LiveTarget, ts: float) -> dict:
        """Próbka urządzenia: porty (prędkość w b/s – None przy pierwszym odczycie – i stan), CPU, RAM i dyski.
        Bez odpowiedzi – same None (panel zostaje przy odczytach z bazy)."""
        oids = (
            [f"{O.IF_HC_IN_OCTETS}.{p.if_index}" for p in target.ports]
            + [f"{O.IF_HC_OUT_OCTETS}.{p.if_index}" for p in target.ports]
            + [f"{O.IF_OPER_STATUS}.{p.if_index}" for p in target.ports]
        )
        driver = DRIVERS[target.driver]()
        values: dict = {}
        try:
            client = await self._client(target.device)
            for i in range(0, len(oids), MAX_OIDS):
                values.update(await client.get(oids[i : i + MAX_OIDS]))
            health = await driver.read_health(client)
            disks = await driver.read_disks(client) if hasattr(driver, "read_disks") else None
        except (SnmpError, TimeoutError, OSError) as exc:
            log.debug("%s: brak odpowiedzi na żywo – %s", target.device.name, exc)
            await self._drop(target.device.id)
            return {
                "ports": [{"id": p.id, "in_bps": None, "out_bps": None, "up": None} for p in target.ports],
                "cpu_percent": None,
                "mem_used_percent": None,
            }
        ports = []
        for p in target.ports:
            key = (target.device.id, p.if_index)
            oper = as_int(values.get(f"{O.IF_OPER_STATUS}.{p.if_index}"))
            ports.append(
                {
                    "id": p.id,
                    "in_bps": self.tracker.bps(key + ("in",), ts, as_int(values.get(f"{O.IF_HC_IN_OCTETS}.{p.if_index}")), 64, p.speed_mbps),
                    "out_bps": self.tracker.bps(key + ("out",), ts, as_int(values.get(f"{O.IF_HC_OUT_OCTETS}.{p.if_index}")), 64, p.speed_mbps),
                    "up": None if oper is None else 1.0 if oper == 1 else 0.0,
                }
            )
        sample: dict = {"ports": ports, "cpu_percent": health.cpu_percent, "mem_used_percent": health.mem_used_percent}
        if disks is not None:
            sample["disks"] = [
                {"mount": d.mount, "used_percent": d.used_percent, "used_bytes": float(d.used_bytes), "free_bytes": float(d.total_bytes - d.used_bytes), "total_bytes": float(d.total_bytes)}
                for d in disks
            ]
        return sample

    async def _refresh_targets(self, now: float) -> None:
        watched = self._watched_devices()
        if now - self._targets_at <= TARGETS_TTL and watched <= self._targets_for:
            return
        self._targets = await self._load_targets(watched)
        self._targets_at = now
        self._targets_for = watched
        active = {t.device.id for t in self._targets}
        for dev_id in [d for d in self._clients if d not in active]:
            await self._drop(dev_id)

    async def sample(self) -> dict[int, dict]:
        """Jedna próbka: wiadomość dla każdego oglądanego urządzenia."""
        now = time.monotonic()
        await self._refresh_targets(now)
        watched = self._watched_devices()
        targets = [t for t in self._targets if t.device.id in watched]
        results = await asyncio.gather(*(self._sample_device(t, now) for t in targets))
        stamp = datetime.now(UTC).isoformat()
        out: dict[int, dict] = {t.device.id: {"time": stamp, **r} for t, r in zip(targets, results, strict=True)}
        for dev_id in watched - out.keys():  # urządzenie bez SNMP albo wyłączone – pusta próbka, żeby panel nie czekał
            out[dev_id] = {"time": stamp, "ports": []}
        return out

    async def _run(self) -> None:
        try:
            while True:
                started = time.monotonic()
                try:
                    msgs = await self.sample()
                except Exception:
                    log.exception("Błąd odczytu na żywo")
                    msgs = {}
                for q, topic in list(self._queues.items()):
                    msg = msgs.get(topic)
                    if msg is None:
                        continue
                    if q.full():  # wolny widz dostaje najnowszą próbkę zamiast kolejki starych
                        with contextlib.suppress(asyncio.QueueEmpty):
                            q.get_nowait()
                    q.put_nowait(msg)
                await asyncio.sleep(max(0.2, self.interval - (time.monotonic() - started)))
        finally:
            for dev_id in list(self._clients):
                await self._drop(dev_id)
            self.tracker = LiveRateTracker()
            self._targets_at = 0.0
            self._targets_for = frozenset()


hub = LiveHub()


@router.websocket("/api/live/device")
async def live_device(ws: WebSocket) -> None:
    device = ws.query_params.get("device", "")
    if not device.isdigit():
        await ws.close(code=1008)
        return
    origin = ws.headers.get("origin")
    if origin and urlsplit(origin).netloc.lower() not in allowed_hosts(ws):
        await ws.close(code=1008)
        return
    if await user_from_request(ws) is None:  # type: ignore[arg-type]
        await ws.close(code=1008)
        return
    queue = hub.subscribe(int(device))
    if queue is None:
        await ws.close(code=1013)
        return
    await ws.accept()
    receive = asyncio.create_task(ws.receive_text())  # kończy się, gdy przeglądarka zamknie połączenie
    try:
        while True:
            get = asyncio.create_task(queue.get())
            done, _ = await asyncio.wait({get, receive}, return_when=asyncio.FIRST_COMPLETED)
            if receive in done:
                get.cancel()
                break
            await ws.send_json(get.result())
    except Exception:
        log.debug("Połączenie na żywo zakończone", exc_info=True)
    finally:
        receive.cancel()
        await hub.unsubscribe(queue)
        with contextlib.suppress(Exception):
            await ws.close()
