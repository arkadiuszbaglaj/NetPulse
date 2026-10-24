"""Kolektor: cyklicznie odpytuje urządzenia i zapisuje metryki."""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert

from .config import settings
from .db import Session
from .db.models import Device, DeviceMetric, Interface, InterfaceMetric, WifiMetric, WifiNetwork
from .drivers import PollResult, poll_device
from .rates import CounterTracker
from .snmp import SnmpClient, SnmpCredentials, SnmpError

log = logging.getLogger("netpulse.collector")


@dataclass(frozen=True)
class DeviceTarget:
    id: int
    name: str
    host: str
    port: int
    driver: str
    credentials: SnmpCredentials


def credentials_for(device: Device) -> SnmpCredentials:
    return SnmpCredentials(
        version=device.snmp_version,  # type: ignore[arg-type]
        community=device.community or "public",
        username=device.v3_username,
        auth_protocol=device.v3_auth_protocol,  # type: ignore[arg-type]
        auth_key=device.v3_auth_key,
        priv_protocol=device.v3_priv_protocol,  # type: ignore[arg-type]
        priv_key=device.v3_priv_key,
        context_name=device.v3_context or "",
    )


def make_client(target: DeviceTarget) -> SnmpClient:
    from .snmp.client import PySnmpClient

    return PySnmpClient(
        target.host,
        target.credentials,
        port=target.port,
        timeout=settings.snmp_timeout,
        retries=settings.snmp_retries,
    )


class Collector:
    def __init__(self, client_factory=make_client) -> None:
        self.tracker = CounterTracker()
        self.client_factory = client_factory
        self._clients: dict[int, tuple[DeviceTarget, SnmpClient]] = {}
        self._last_uptime: dict[int, float] = {}

    # --- pętla główna -----------------------------------------------------------

    async def run_forever(self) -> None:
        log.info("Kolektor start: interwał %ss", settings.poll_interval)
        while True:
            started = time.monotonic()
            try:
                await self.poll_all()
            except Exception:
                log.exception("Błąd cyklu odpytywania")
            elapsed = time.monotonic() - started
            await asyncio.sleep(max(1.0, settings.poll_interval - elapsed))

    async def load_targets(self) -> list[DeviceTarget]:
        async with Session() as session:
            devices = (await session.scalars(select(Device).where(Device.enabled))).all()
            return [
                DeviceTarget(d.id, d.name, d.host, d.port, d.driver, credentials_for(d))
                for d in devices
            ]

    async def poll_all(self) -> None:
        targets = await self.load_targets()
        active = {t.id for t in targets}
        for dev_id in [d for d in self._clients if d not in active]:
            await self._drop_client(dev_id)
        if not targets:
            log.info("Brak urządzeń do odpytania – dodaj je: netpulse device add")
            return
        sem = asyncio.Semaphore(settings.poll_concurrency)

        async def guarded(t: DeviceTarget) -> None:
            async with sem:
                await self.poll_one(t)

        await asyncio.gather(*(guarded(t) for t in targets))

    async def _client(self, target: DeviceTarget) -> SnmpClient:
        cached = self._clients.get(target.id)
        if cached and cached[0] == target:
            return cached[1]
        if cached:
            await self._drop_client(target.id)
        client = self.client_factory(target)
        self._clients[target.id] = (target, client)
        return client

    async def _drop_client(self, dev_id: int) -> None:
        cached = self._clients.pop(dev_id, None)
        if cached:
            await cached[1].close()

    # --- jedno urządzenie --------------------------------------------------------

    async def poll_one(self, target: DeviceTarget) -> PollResult | None:
        started = time.monotonic()
        now = datetime.now(UTC)
        try:
            client = await self._client(target)
            result = await poll_device(client, target.driver)
        except (SnmpError, TimeoutError, OSError) as exc:
            log.warning("%s (%s): brak odpowiedzi – %s", target.name, target.host, exc)
            await self._drop_client(target.id)
            await self.save_failure(target, now, str(exc))
            return None
        except Exception as exc:
            log.exception("%s (%s): błąd odczytu", target.name, target.host)
            await self.save_failure(target, now, f"{type(exc).__name__}: {exc}")
            return None
        poll_ms = (time.monotonic() - started) * 1000
        await self.save_result(target, result, now, poll_ms)
        log.debug(
            "%s: %d interfejsów, %d sieci WiFi, %.0f ms",
            target.name,
            len(result.interfaces),
            len(result.wifi),
            poll_ms,
        )
        return result

    async def save_failure(self, target: DeviceTarget, now: datetime, error: str) -> None:
        async with Session() as session, session.begin():
            await session.execute(
                update(Device)
                .where(Device.id == target.id)
                .values(status="down", last_polled_at=now, last_error=error[:2000])
            )
            session.add(DeviceMetric(time=now, device_id=target.id, reachable=False))

    async def save_result(
        self, target: DeviceTarget, result: PollResult, now: datetime, poll_ms: float
    ) -> None:
        ts = now.timestamp()
        sysinfo = result.system
        dev_id = target.id

        # Restart urządzenia (uptime spadł) – liczniki zaczynają od zera
        if sysinfo.uptime_s is not None:
            prev = self._last_uptime.get(dev_id)
            if prev is not None and sysinfo.uptime_s < prev:
                log.info("%s: wykryto restart urządzenia", target.name)
                self.tracker.forget(lambda k: k[0] == dev_id)
            self._last_uptime[dev_id] = sysinfo.uptime_s

        async with Session() as session, session.begin():
            await session.execute(
                update(Device)
                .where(Device.id == dev_id)
                .values(
                    status="up",
                    last_polled_at=now,
                    last_ok_at=now,
                    last_error=None,
                    detected_driver=result.driver,
                    kind=sysinfo.kind,
                    vendor=sysinfo.vendor,
                    model=sysinfo.model,
                    firmware=sysinfo.firmware,
                    sys_name=sysinfo.name,
                    sys_descr=sysinfo.descr,
                    sys_object_id=sysinfo.object_id,
                    uptime_s=sysinfo.uptime_s,
                )
            )

            # Interfejsy: upsert + metryki
            if result.interfaces:
                rows = [
                    {
                        "device_id": dev_id,
                        "if_index": i.if_index,
                        "name": i.name[:128],
                        "descr": (i.descr or "")[:255] or None,
                        "alias": (i.alias or "")[:255] or None,
                        "label": i.label[:128],
                        "if_type": i.if_type,
                        "mac": i.mac,
                        "role": i.role,
                        "hidden": i.hidden,
                        "admin_up": i.admin_up,
                        "oper_status": i.oper_status,
                        "speed_mbps": i.speed_mbps,
                        "last_seen_at": now,
                    }
                    for i in result.interfaces
                ]
                stmt = insert(Interface).values(rows)
                stmt = stmt.on_conflict_do_update(
                    index_elements=["device_id", "if_index"],
                    set_={c: stmt.excluded[c] for c in rows[0] if c not in ("device_id", "if_index")},
                ).returning(Interface.id, Interface.if_index)
                ids = {row.if_index: row.id for row in await session.execute(stmt)}

                metrics = []
                for i in result.interfaces:
                    key = (dev_id, "if", i.if_index)
                    in_bps = self.tracker.bps(key + ("in",), ts, i.in_octets, i.counter_bits, i.speed_mbps)
                    out_bps = self.tracker.bps(key + ("out",), ts, i.out_octets, i.counter_bits, i.speed_mbps)
                    deltas = {}
                    for field in ("in_errors", "out_errors", "in_discards", "out_discards"):
                        res = self.tracker.update(key + (field,), ts, getattr(i, field), 32)
                        deltas[field] = res[0] if res else None
                    if in_bps is None and out_bps is None and all(v is None for v in deltas.values()):
                        continue  # pierwszy odczyt – nie ma jeszcze z czym porównać
                    metrics.append(
                        InterfaceMetric(
                            time=now,
                            interface_id=ids[i.if_index],
                            in_bps=in_bps,
                            out_bps=out_bps,
                            oper_up=i.oper_status == "up",
                            **deltas,
                        )
                    )
                session.add_all(metrics)

            # WiFi: upsert + metryki
            if result.wifi:
                rows = [
                    {
                        "device_id": dev_id,
                        "key": w.key[:64],
                        "ssid": w.ssid[:64],
                        "radio": w.radio,
                        "channel": w.channel,
                        "bssid": w.bssid,
                        "hidden": w.hidden,
                        "clients": w.clients,
                        "last_seen_at": now,
                    }
                    for w in result.wifi
                ]
                stmt = insert(WifiNetwork).values(rows)
                stmt = stmt.on_conflict_do_update(
                    index_elements=["device_id", "key"],
                    set_={c: stmt.excluded[c] for c in rows[0] if c not in ("device_id", "key")},
                ).returning(WifiNetwork.id, WifiNetwork.key)
                wifi_ids = {row.key: row.id for row in await session.execute(stmt)}
                for w in result.wifi:
                    key = (dev_id, "wifi", w.key)
                    rx = self.tracker.bps(key + ("rx",), ts, w.rx_octets, w.counter_bits)
                    tx = self.tracker.bps(key + ("tx",), ts, w.tx_octets, w.counter_bits)
                    session.add(
                        WifiMetric(
                            time=now, wifi_id=wifi_ids[w.key[:64]], clients=w.clients, rx_bps=rx, tx_bps=tx
                        )
                    )

            h = result.health
            session.add(
                DeviceMetric(
                    time=now,
                    device_id=dev_id,
                    reachable=True,
                    poll_ms=round(poll_ms, 1),
                    uptime_s=sysinfo.uptime_s,
                    cpu_percent=h.cpu_percent,
                    mem_used_percent=h.mem_used_percent,
                    load1=h.load1,
                )
            )


async def run() -> None:
    from .db import init_db

    await init_db()
    await Collector().run_forever()
