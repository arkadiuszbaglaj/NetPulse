"""Tryb „Na żywo”: prędkość WAN co ~1,5 s przez WebSocket (`/api/live/wan`).

Dopóki ktoś jest połączony, jedno wspólne odpytywanie liczników WAN routera (bez zapisu do bazy);
gdy ostatni widz odejdzie, odpytywanie się kończy i klienty SNMP są zamykane."""

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
from ..rates import CounterTracker
from ..snmp import SnmpClient, SnmpError, as_int
from ..snmp import oids as O
from .security import allowed_hosts, user_from_request

log = logging.getLogger("netpulse.live")
router = APIRouter(tags=["na żywo"])

LIVE_INTERVAL = 1.5  # s; nie szybciej, żeby nie przeciążać routera
MAX_VIEWERS = 10
TARGETS_TTL = 30.0  # jak często odświeżać listę interfejsów WAN


@dataclass(frozen=True)
class WanTarget:
    device: DeviceTarget
    if_indexes: tuple[int, ...]
    speeds: tuple[int | None, ...]


class LiveHub:
    def __init__(self, client_factory=make_client, interval: float = LIVE_INTERVAL, max_viewers: int = MAX_VIEWERS) -> None:
        self.client_factory = client_factory
        self.interval = interval
        self.max_viewers = max_viewers
        self.tracker = CounterTracker()
        self._queues: set[asyncio.Queue[dict]] = set()
        self._task: asyncio.Task | None = None
        self._clients: dict[int, tuple[DeviceTarget, SnmpClient]] = {}
        self._targets: list[WanTarget] = []
        self._targets_at = 0.0

    @property
    def viewers(self) -> int:
        return len(self._queues)

    def subscribe(self) -> asyncio.Queue[dict] | None:
        """Kolejka próbek dla nowego widza albo None, gdy osiągnięto limit."""
        if len(self._queues) >= self.max_viewers:
            return None
        q: asyncio.Queue[dict] = asyncio.Queue(maxsize=4)
        self._queues.add(q)
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run())
        return q

    async def unsubscribe(self, q: asyncio.Queue[dict]) -> None:
        self._queues.discard(q)
        if not self._queues and self._task is not None:
            task, self._task = self._task, None
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    # --- odpytywanie ---------------------------------------------------------------

    async def _load_targets(self) -> list[WanTarget]:
        async with Session() as session:
            rows = (
                await session.execute(
                    select(Device, Interface.if_index, Interface.speed_mbps)
                    .join(Interface, Interface.device_id == Device.id)
                    .where(Interface.role == "wan", Device.enabled)
                    .order_by(Device.id, Interface.if_index)
                )
            ).all()
        grouped: dict[int, tuple[Device, list[int], list[int | None]]] = {}
        for device, idx, speed in rows:
            grouped.setdefault(device.id, (device, [], []))[1].append(idx)
            grouped[device.id][2].append(speed)
        return [
            WanTarget(
                DeviceTarget(d.id, d.name, d.host, d.port, d.driver, credentials_for(d)),
                tuple(idxs),
                tuple(speeds),
            )
            for d, idxs, speeds in grouped.values()
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

    async def _sample_device(self, wan: WanTarget, ts: float) -> tuple[list[float], list[float]]:
        oids = [f"{O.IF_HC_IN_OCTETS}.{i}" for i in wan.if_indexes] + [f"{O.IF_HC_OUT_OCTETS}.{i}" for i in wan.if_indexes]
        try:
            client = await self._client(wan.device)
            values = await client.get(oids)
        except (SnmpError, TimeoutError, OSError) as exc:
            log.debug("%s: brak odpowiedzi na żywo – %s", wan.device.name, exc)
            await self._drop(wan.device.id)
            return [], []
        ins: list[float] = []
        outs: list[float] = []
        for idx, speed in zip(wan.if_indexes, wan.speeds, strict=True):
            key = (wan.device.id, idx)
            i = self.tracker.bps(key + ("in",), ts, as_int(values.get(f"{O.IF_HC_IN_OCTETS}.{idx}")), 64, speed)
            o = self.tracker.bps(key + ("out",), ts, as_int(values.get(f"{O.IF_HC_OUT_OCTETS}.{idx}")), 64, speed)
            if i is not None:
                ins.append(i)
            if o is not None:
                outs.append(o)
        return ins, outs

    async def sample(self) -> dict:
        """Jedna próbka: suma prędkości po wszystkich interfejsach WAN (None przy pierwszym odczycie)."""
        now = time.monotonic()
        if now - self._targets_at > TARGETS_TTL:
            self._targets = await self._load_targets()
            self._targets_at = now
            active = {t.device.id for t in self._targets}
            for dev_id in [d for d in self._clients if d not in active]:
                await self._drop(dev_id)
        results = await asyncio.gather(*(self._sample_device(t, now) for t in self._targets))
        ins = [v for r in results for v in r[0]]
        outs = [v for r in results for v in r[1]]
        return {
            "time": datetime.now(UTC).isoformat(),
            "in_bps": sum(ins) if ins else None,
            "out_bps": sum(outs) if outs else None,
        }

    async def _run(self) -> None:
        try:
            while True:
                started = time.monotonic()
                try:
                    msg = await self.sample()
                except Exception:
                    log.exception("Błąd odczytu na żywo")
                    msg = None
                if msg is not None:
                    for q in list(self._queues):
                        if q.full():  # wolny widz dostaje najnowszą próbkę zamiast kolejki starych
                            with contextlib.suppress(asyncio.QueueEmpty):
                                q.get_nowait()
                        q.put_nowait(msg)
                await asyncio.sleep(max(0.2, self.interval - (time.monotonic() - started)))
        finally:
            for dev_id in list(self._clients):
                await self._drop(dev_id)
            self.tracker = CounterTracker()
            self._targets_at = 0.0


hub = LiveHub()


@router.websocket("/api/live/wan")
async def live_wan(ws: WebSocket) -> None:
    origin = ws.headers.get("origin")
    if origin and urlsplit(origin).netloc.lower() not in allowed_hosts(ws):
        await ws.close(code=1008)
        return
    if await user_from_request(ws) is None:  # type: ignore[arg-type]
        await ws.close(code=1008)
        return
    queue = hub.subscribe()
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
