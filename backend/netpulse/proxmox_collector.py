"""Kolektor Proxmox VE: węzły, maszyny VM/LXC, magazyny i kopie zapasowe (co cykl, razem z kolektorem SNMP).

Węzeł Proxmox staje się urządzeniem NetPulse (`driver = "proxmox"`, rodzaj „Serwer”), więc działają dla niego
karta serwera, alerty (nie odpowiada, CPU, RAM, dysk) i wykresy. Do tabel wpisujemy:
- `device_metrics` (CPU, RAM, obciążenie, czas pracy węzła), `disk_metrics` (system plików węzła i magazyny),
- `metrics` (ogólna): `guest_up`, `guest_cpu_percent`, `guest_mem_bytes`, `guest_net_rx_bps`/`tx`,
  `guest_disk_read_bps`/`write` (klucz: „nazwa (vmid)”), `backup_task_ok` (klucz „vzdump”), `backup_age_h`.
Kopie zapasowe (zadania vzdump i pliki kopii) czytamy rzadziej – co BACKUP_EVERY_S.
"""

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
from .db.models import (
    Device,
    DeviceMetric,
    DiskMetric,
    Metric,
    ProxmoxGuest,
    ProxmoxNode,
    ProxmoxServer,
    ProxmoxStorage,
)
from .proxmox import ProxmoxApi, ProxmoxError, PveSnapshot, PveTask

log = logging.getLogger("netpulse.proxmox")

BACKUP_EVERY_S = 600


@dataclass(frozen=True)
class ServerTarget:
    id: int
    name: str
    host: str
    port: int
    token_id: str
    token_secret: str
    verify_tls: bool


@dataclass
class BackupInfo:
    """Wynik ostatniego odczytu kopii: ostatnie zakończone zadanie na węźle i czas ostatniej kopii każdej VM."""

    tasks: dict[str, PveTask | None]
    last_backup: dict[int, datetime]


def make_api(t: ServerTarget) -> ProxmoxApi:
    return ProxmoxApi(t.host, t.token_id, t.token_secret, port=t.port, verify_tls=t.verify_tls, timeout=max(5.0, settings.snmp_timeout * 3))


def node_host(node: str, ip: str | None, taken: set[str]) -> str:
    """Adres urządzenia w panelu: IP węzła, a gdy jest już zajęte (np. ten sam serwer przez SNMP) – nazwa węzła."""
    for candidate in (ip, f"{node}.proxmox", f"{node}.proxmox-{len(taken)}"):
        if candidate and candidate not in taken:
            return candidate
    return f"{node}.proxmox-{time.time_ns()}"


class ProxmoxCollector:
    def __init__(self, api_factory=make_api) -> None:
        self.api_factory = api_factory
        self._counters: dict[tuple, tuple[float, int]] = {}
        self._backups: dict[int, tuple[float, BackupInfo]] = {}

    async def run_forever(self) -> None:
        log.info("Kolektor Proxmox start: interwał %ss", settings.poll_interval)
        while True:
            started = time.monotonic()
            try:
                await self.poll_all()
            except Exception:
                log.exception("Błąd cyklu odpytywania Proxmox")
            await asyncio.sleep(max(1.0, settings.poll_interval - (time.monotonic() - started)))

    async def load_targets(self) -> list[ServerTarget]:
        async with Session() as session:
            rows = (await session.scalars(select(ProxmoxServer).where(ProxmoxServer.enabled))).all()
        return [ServerTarget(s.id, s.name, s.host, s.port, s.token_id, s.token_secret or "", s.verify_tls) for s in rows]

    async def poll_all(self) -> None:
        targets = await self.load_targets()
        if targets:
            await asyncio.gather(*(self.poll_one(t) for t in targets))

    # --- odczyt ---------------------------------------------------------------------------

    async def poll_one(self, target: ServerTarget) -> bool:
        now = datetime.now(UTC)
        api = self.api_factory(target)
        try:
            snap = await api.snapshot()
            online = [n.name for n in snap.nodes if n.online]
            loads = await asyncio.gather(*(api.node_load(n) for n in online), return_exceptions=True)
            load = {n: res for n, res in zip(online, loads, strict=True) if not isinstance(res, BaseException)}
            backups = await self._backup_info(api, target, snap)
        except ProxmoxError as exc:
            log.warning("%s (%s): %s", target.name, target.host, exc)
            await self.save_failure(target, now, str(exc))
            return False
        except Exception as exc:
            log.exception("%s (%s): błąd odczytu Proxmox", target.name, target.host)
            await self.save_failure(target, now, f"{type(exc).__name__}: {exc}")
            return False
        finally:
            await api.close()
        await self.save_result(target, now, snap, load, backups)
        return True

    async def _backup_info(self, api: ProxmoxApi, target: ServerTarget, snap: PveSnapshot) -> BackupInfo | None:
        cached = self._backups.get(target.id)
        if cached and time.monotonic() - cached[0] < BACKUP_EVERY_S:
            return cached[1]
        tasks: dict[str, PveTask | None] = {}
        last: dict[int, datetime] = {}
        for node in (n.name for n in snap.nodes if n.online):
            try:
                finished = [t for t in await api.backup_tasks(node) if t.ok is not None]
                tasks[node] = finished[0] if finished else None
            except ProxmoxError as exc:
                log.debug("%s: zadania kopii z %s niedostępne: %s", target.name, node, exc)
        # Magazyny z kopiami: współdzielony wystarczy przeczytać raz
        seen_shared: set[str] = set()
        for st in snap.storages:
            if "backup" not in st.content or not st.active or (st.shared and st.storage in seen_shared):
                continue
            if st.node not in {n.name for n in snap.nodes if n.online}:
                continue
            seen_shared.add(st.storage)
            try:
                for b in await api.backups(st.node, st.storage):
                    if b.vmid not in last or b.created > last[b.vmid]:
                        last[b.vmid] = b.created
            except ProxmoxError as exc:
                log.debug("%s: kopie z %s/%s niedostępne: %s", target.name, st.node, st.storage, exc)
        info = BackupInfo(tasks=tasks, last_backup=last)
        self._backups[target.id] = (time.monotonic(), info)
        return info

    def _rate(self, key: tuple, ts: float, value: int | None, factor: float = 1.0) -> float | None:
        """Przyrost licznika na sekundę; restart maszyny (licznik spadł) – brak wartości."""
        if value is None:
            self._counters.pop(key, None)
            return None
        prev = self._counters.get(key)
        self._counters[key] = (ts, value)
        if prev is None or ts <= prev[0] or value < prev[1]:
            return None
        return round((value - prev[1]) / (ts - prev[0]) * factor, 1)

    # --- zapis ------------------------------------------------------------------------------

    async def save_failure(self, target: ServerTarget, now: datetime, error: str) -> None:
        async def write(session) -> None:
            await session.execute(
                update(ProxmoxServer).where(ProxmoxServer.id == target.id).values(status="down", last_polled_at=now, last_error=error[:2000])
            )
            # Węzły tego serwera są wtedy niedostępne (alert „urządzenie nie odpowiada”)
            ids = (await session.scalars(select(ProxmoxNode.device_id).where(ProxmoxNode.server_id == target.id))).all()
            if ids:
                await session.execute(
                    update(Device).where(Device.id.in_(ids)).values(status="down", last_polled_at=now, last_error=f"Proxmox: {error}"[:2000])
                )
                session.add_all(DeviceMetric(time=now, device_id=i, reachable=False) for i in ids)

        await _write_with_retry(write)

    async def save_result(
        self, target: ServerTarget, now: datetime, snap: PveSnapshot, load: dict[str, tuple[float, ...]], backups: BackupInfo | None
    ) -> None:
        ts = now.timestamp()
        # Szybkości liczymy przed zapisem, żeby ponowienie zapisu nie psuło liczników
        rates = {
            g.vmid: {
                "guest_net_rx_bps": self._rate((target.id, g.vmid, "netin"), ts, g.netin, 8.0),
                "guest_net_tx_bps": self._rate((target.id, g.vmid, "netout"), ts, g.netout, 8.0),
                "guest_disk_read_bps": self._rate((target.id, g.vmid, "diskread"), ts, g.diskread),
                "guest_disk_write_bps": self._rate((target.id, g.vmid, "diskwrite"), ts, g.diskwrite),
            }
            for g in snap.guests
        }

        async def write(session) -> None:
            await session.execute(
                update(ProxmoxServer)
                .where(ProxmoxServer.id == target.id)
                .values(status="up", last_polled_at=now, last_ok_at=now, last_error=None, version=snap.version, cluster_name=snap.cluster)
            )
            devices = await self._ensure_node_devices(session, target, snap, now)

            for n in snap.nodes:
                dev_id = devices[n.name]
                values = dict(last_polled_at=now, uptime_s=n.uptime_s, firmware=snap.version, model=f"Proxmox VE {snap.version or ''}".strip())
                if n.online:
                    values.update(status="up", last_ok_at=now, last_error=None)
                else:
                    values.update(status="down", last_error="Węzeł offline w klastrze Proxmox")
                await session.execute(update(Device).where(Device.id == dev_id).values(**values))
                node_load = load.get(n.name) or ()
                session.add(
                    DeviceMetric(
                        time=now,
                        device_id=dev_id,
                        reachable=n.online,
                        uptime_s=n.uptime_s,
                        cpu_percent=n.cpu_percent,
                        mem_used_percent=round(100.0 * n.mem_used / n.mem_total, 1) if n.mem_used is not None and n.mem_total else None,
                        load1=node_load[0] if node_load else None,
                    )
                )
                if n.online and n.disk_total:
                    session.add(DiskMetric(time=now, device_id=dev_id, mount="/", total_bytes=n.disk_total, used_bytes=n.disk_used or 0))

            # Magazyny: współdzielony przypisujemy pierwszemu węzłowi (alfabetycznie), żeby nie liczyć go kilka razy
            storages = {}
            for st in sorted(snap.storages, key=lambda s: (s.storage, s.node)):
                if st.shared and any(k[1] == st.storage for k in storages):
                    continue
                storages[(st.node, st.storage)] = st
            await session.execute(delete(ProxmoxStorage).where(ProxmoxStorage.server_id == target.id))
            for (node, name), st in storages.items():
                session.add(
                    ProxmoxStorage(
                        server_id=target.id, node=node, storage=name, type=st.type, shared=st.shared, active=st.active,
                        content=",".join(st.content)[:255] or None, used_bytes=st.used, total_bytes=st.total, updated_at=now,
                    )
                )  # fmt: skip
                if st.active and st.total and node in devices:
                    session.add(DiskMetric(time=now, device_id=devices[node], mount=f"{name} ({st.type or 'storage'})"[:255], total_bytes=st.total, used_bytes=st.used or 0))

            # Maszyny: zdjęcie stanu + metryki na urządzeniu węzła
            last_backup = backups.last_backup if backups else {}
            rows = [
                {
                    "server_id": target.id, "vmid": g.vmid, "node": g.node[:64], "type": g.type, "name": g.name[:255], "status": g.status[:16],
                    "template": g.template, "tags": (g.tags or "")[:255] or None, "cpus": g.cpus, "cpu_percent": g.cpu_percent,
                    "mem_used": g.mem_used, "mem_total": g.mem_total, "disk_used": g.disk_used, "disk_total": g.disk_total,
                    "uptime_s": g.uptime_s, "last_backup_at": last_backup.get(g.vmid), "updated_at": now,
                }
                for g in snap.guests
            ]  # fmt: skip
            if rows:
                stmt = insert(ProxmoxGuest).values(rows)
                stmt = stmt.on_conflict_do_update(
                    index_elements=["server_id", "vmid"],
                    set_={c: stmt.excluded[c] for c in rows[0] if c not in ("server_id", "vmid", "last_backup_at")}
                    # czas kopii nadpisujemy tylko, gdy właśnie czytaliśmy kopie
                    | ({"last_backup_at": stmt.excluded["last_backup_at"]} if backups else {}),
                )
                await session.execute(stmt)
            await session.execute(
                delete(ProxmoxGuest).where(ProxmoxGuest.server_id == target.id, ProxmoxGuest.vmid.not_in([g.vmid for g in snap.guests] or [-1]))
            )
            if not backups:
                last_backup = dict(
                    (await session.execute(
                        select(ProxmoxGuest.vmid, ProxmoxGuest.last_backup_at)
                        .where(ProxmoxGuest.server_id == target.id, ProxmoxGuest.last_backup_at.is_not(None))
                    )).all()
                )  # fmt: skip

            metrics: dict[tuple[int, str, str], float] = {}

            def add(dev_id: int | None, name: str, key: str, value: float | None) -> None:
                if dev_id is not None and value is not None:
                    metrics[(dev_id, name, key[:255])] = float(value)

            for g in snap.guests:
                if g.template:
                    continue
                dev_id = devices.get(g.node)
                add(dev_id, "guest_up", g.key, 1.0 if g.status == "running" else 0.0)
                add(dev_id, "guest_cpu_percent", g.key, g.cpu_percent)
                add(dev_id, "guest_mem_bytes", g.key, g.mem_used)
                for name, value in rates[g.vmid].items():
                    add(dev_id, name, g.key, value)
                if g.vmid in last_backup:
                    add(dev_id, "backup_age_h", g.key, round((now - last_backup[g.vmid]).total_seconds() / 3600, 1))
            for node, task in (backups.tasks if backups else {}).items():
                if task is not None:
                    add(devices.get(node), "backup_task_ok", "vzdump", 1.0 if task.ok else 0.0)
                    await session.execute(
                        update(ProxmoxNode)
                        .where(ProxmoxNode.server_id == target.id, ProxmoxNode.node == node)
                        .values(backup_status=(task.status or "")[:255], backup_at=task.end or task.start)
                    )
            if not backups:
                # Między odczytami kopii powtarzamy ostatni znany wynik zadania, żeby alert się nie urywał
                for node, status in (await session.execute(
                    select(ProxmoxNode.node, ProxmoxNode.backup_status).where(ProxmoxNode.server_id == target.id, ProxmoxNode.backup_status.is_not(None))
                )).all():  # fmt: skip
                    add(devices.get(node), "backup_task_ok", "vzdump", 1.0 if status == "OK" or status.startswith("WARNINGS") else 0.0)
            if metrics:
                await session.execute(
                    insert(Metric), [{"time": now, "device_id": d, "name": n, "key": k, "value": v} for (d, n, k), v in metrics.items()]
                )

        await _write_with_retry(write)

    async def _ensure_node_devices(self, session, target: ServerTarget, snap: PveSnapshot, now: datetime) -> dict[str, int]:
        """Urządzenie NetPulse dla każdego węzła (tworzone przy pierwszym odczycie); zwraca {węzeł: id urządzenia}."""
        known = {n.node: n for n in (await session.scalars(select(ProxmoxNode).where(ProxmoxNode.server_id == target.id))).all()}
        taken = set((await session.scalars(select(Device.host))).all())
        out: dict[str, int] = {}
        for n in snap.nodes:
            mapping = known.get(n.name)
            if mapping is None:
                host = node_host(n.name, n.ip, taken)
                taken.add(host)
                device = Device(
                    name=n.name, host=host, port=0, driver="proxmox", detected_driver="proxmox", kind="server",
                    vendor="Proxmox", sys_name=n.name, community=None, status="unknown",
                )  # fmt: skip
                session.add(device)
                await session.flush()
                mapping = ProxmoxNode(server_id=target.id, node=n.name, device_id=device.id, ip=n.ip, online=n.online, updated_at=now)
                session.add(mapping)
                log.info("%s: nowy węzeł Proxmox %s (urządzenie %d)", target.name, n.name, device.id)
            else:
                mapping.ip, mapping.online, mapping.updated_at = n.ip, n.online, now
            out[n.name] = mapping.device_id
        return out
