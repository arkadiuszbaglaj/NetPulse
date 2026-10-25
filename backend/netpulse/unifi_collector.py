"""Kolektor kontrolerów UniFi: PoE na portach switchy i klienci sieci (co cykl, razem z kolektorem SNMP)."""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import delete, select, update
from sqlalchemy.dialects.postgresql import insert

from .collector import _write_with_retry
from .config import settings
from .db import Session
from .db.models import Controller, Device, Interface, NetworkClient, PoeBudgetMetric, PoePortMetric, TopologyLink
from .unifi import UnifiApi, UnifiClient, UnifiDevice, UnifiError

log = logging.getLogger("netpulse.unifi")


@dataclass(frozen=True)
class ControllerTarget:
    id: int
    name: str
    host: str
    port: int
    api_key: str
    site: str
    verify_tls: bool


def make_api(target: ControllerTarget) -> UnifiApi:
    return UnifiApi(
        target.host,
        target.api_key,
        port=target.port,
        site=target.site,
        verify_tls=target.verify_tls,
        timeout=max(5.0, settings.snmp_timeout * 3),
    )


def match_devices(devices: list[UnifiDevice], by_host: dict[str, int], by_iface_mac: dict[str, int]) -> dict[str, int]:
    """Łączy urządzenia kontrolera z urządzeniami NetPulse (SNMP): {MAC z kontrolera: id urządzenia}.

    Samo pole `ip` z kontrolera bywa mylące (brama podaje tam adres WAN), więc próbujemy po kolei:
    1) `ip` z kontrolera, 2) adresy, pod którymi widzą to urządzenie sąsiedzi w LLDP (adres w sieci LAN),
    3) adresy MAC interfejsów, które NetPulse zna z SNMP (ifPhysAddress)."""
    lan_ips: dict[str, list[str]] = {}
    for d in devices:
        for link in d.lldp:
            lan_ips.setdefault(link.remote_mac, []).extend(link.remote_ips)
    matched: dict[str, int] = {}
    for d in devices:
        for ip in [d.ip, *lan_ips.get(d.mac, [])]:
            if ip in by_host:
                matched[d.mac] = by_host[ip]
                break
        else:
            for mac in d.macs:
                if mac in by_iface_mac:
                    matched[d.mac] = by_iface_mac[mac]
                    break
    return matched


class UnifiCollector:
    def __init__(self, api_factory=make_api) -> None:
        self.api_factory = api_factory

    async def run_forever(self) -> None:
        log.info("Kolektor UniFi start: interwał %ss", settings.poll_interval)
        while True:
            started = time.monotonic()
            try:
                await self.poll_all()
            except Exception:
                log.exception("Błąd cyklu odpytywania kontrolerów UniFi")
            await asyncio.sleep(max(1.0, settings.poll_interval - (time.monotonic() - started)))

    async def load_targets(self) -> list[ControllerTarget]:
        async with Session() as session:
            rows = (await session.scalars(select(Controller).where(Controller.enabled))).all()
        return [ControllerTarget(c.id, c.name, c.host, c.port, c.api_key, c.site, c.verify_tls) for c in rows]

    async def poll_all(self) -> None:
        targets = await self.load_targets()
        if targets:
            await asyncio.gather(*(self.poll_one(t) for t in targets))

    async def poll_one(self, target: ControllerTarget) -> bool:
        now = datetime.now(UTC)
        api = self.api_factory(target)
        try:
            version = await api.app_version()
            devices, clients = await asyncio.gather(api.devices(), api.clients())
        except UnifiError as exc:
            log.warning("%s (%s): %s", target.name, target.host, exc)
            await self.save_failure(target, now, str(exc))
            return False
        except Exception as exc:
            log.exception("%s (%s): błąd odczytu kontrolera", target.name, target.host)
            await self.save_failure(target, now, f"{type(exc).__name__}: {exc}")
            return False
        finally:
            await api.close()
        await self.save_result(target, now, version, devices, clients)
        return True

    async def save_failure(self, target: ControllerTarget, now: datetime, error: str) -> None:
        async def write(session) -> None:
            await session.execute(
                update(Controller)
                .where(Controller.id == target.id)
                .values(status="down", last_polled_at=now, last_error=error[:2000])
            )

        await _write_with_retry(write)

    async def save_result(
        self,
        target: ControllerTarget,
        now: datetime,
        version: str | None,
        devices: list[UnifiDevice],
        clients: list[UnifiClient],
    ) -> None:
        async def write(session) -> None:
            await session.execute(
                update(Controller)
                .where(Controller.id == target.id)
                .values(
                    status="up", last_polled_at=now, last_ok_at=now, last_error=None, app_version=version
                )
            )
            # Urządzenia NetPulse (SNMP) łączymy z kontrolerem po adresie IP
            by_host = {host: dev_id for dev_id, host in (await session.execute(select(Device.id, Device.host))).all()}
            by_iface_mac = {
                mac.lower(): dev_id
                for dev_id, mac in (
                    await session.execute(select(Interface.device_id, Interface.mac).where(Interface.mac.is_not(None)))
                ).all()
            }
            by_mac = match_devices(devices, by_host, by_iface_mac)

            for d in devices:
                dev_id = by_mac.get(d.mac)
                if dev_id is None:
                    continue
                session.add_all(
                    PoePortMetric(
                        time=now,
                        device_id=dev_id,
                        port_idx=p.port_idx,
                        power_w=p.power_w,
                        voltage_v=p.voltage_v,
                        current_ma=p.current_ma,
                        poe_mode=p.poe_mode,
                        poe_class=p.poe_class,
                        delivering=p.delivering,
                    )
                    for p in d.poe_ports
                )
                if d.poe_ports and (d.poe_used_w is not None or d.poe_max_w is not None):
                    session.add(PoeBudgetMetric(time=now, device_id=dev_id, used_w=d.poe_used_w, max_w=d.poe_max_w))

            # Topologia: zdjęcie stanu połączeń LLDP urządzeń, które znamy z SNMP
            links = [
                {
                    "controller_id": target.id,
                    "device_id": by_mac[d.mac],
                    "local_port_idx": link.local_port_idx,
                    "remote_mac": link.remote_mac,
                    "local_mac": d.mac,
                    "updated_at": now,
                }
                for d in devices
                if d.mac in by_mac
                for link in d.lldp
            ]
            await session.execute(delete(TopologyLink).where(TopologyLink.controller_id == target.id))
            if links:
                await session.execute(insert(TopologyLink).values(links).on_conflict_do_nothing())

            # Klienci: zdjęcie stanu – zniknięci z kontrolera znikają też u nas
            names = {d.mac: d.name for d in devices}
            await session.execute(
                delete(NetworkClient).where(
                    NetworkClient.controller_id == target.id, NetworkClient.mac.not_in([c.mac for c in clients] or [""])
                )
            )
            if clients:
                rows = [
                    {
                        "controller_id": target.id,
                        "mac": c.mac,
                        "name": (c.name or "")[:255] or None,
                        "ip": c.ip,
                        "is_wired": c.is_wired,
                        "is_guest": c.is_guest,
                        "essid": c.essid,
                        "radio": c.radio,
                        "signal_dbm": c.signal_dbm,
                        "tx_rate_kbps": c.tx_rate_kbps,
                        "rx_rate_kbps": c.rx_rate_kbps,
                        "uplink_device_id": by_mac.get(c.uplink_mac) if c.uplink_mac else None,
                        "uplink_name": (names.get(c.uplink_mac) or "")[:128] or None if c.uplink_mac else None,
                        "uplink_port": c.uplink_port,
                        "connected_s": c.connected_s,
                        "updated_at": now,
                    }
                    for c in clients
                ]
                stmt = insert(NetworkClient).values(rows)
                stmt = stmt.on_conflict_do_update(
                    index_elements=["controller_id", "mac"],
                    set_={k: stmt.excluded[k] for k in rows[0] if k not in ("controller_id", "mac")},
                )
                await session.execute(stmt)

        await _write_with_retry(write)
        log.debug("%s: %d urządzeń, %d klientów", target.name, len(devices), len(clients))
