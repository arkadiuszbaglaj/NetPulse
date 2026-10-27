"""Klient Proxmox VE API (token API) i parsery odpowiedzi.

Logowanie tokenem: nagłówek `Authorization: PVEAPIToken=<użytkownik>@<realm>!<id tokenu>=<sekret>`.
Wystarczy rola `PVEAuditor` (tylko odczyt) na `/`. Używane zasoby (Proxmox VE 7–9):
  GET /version                         wersja
  GET /cluster/status                  nazwa klastra, węzły z adresami IP i stanem online
  GET /cluster/resources               węzły, VM (qemu), kontenery (lxc) i magazyny z bieżącym zużyciem
  GET /nodes/<węzeł>/status            obciążenie (loadavg) węzła
  GET /nodes/<węzeł>/tasks?typefilter=vzdump   ostatnie zadania kopii zapasowych
  GET /nodes/<węzeł>/storage/<magazyn>/content?content=backup   pliki kopii (czas ostatniej kopii każdej VM;
                                                                PVEAuditor ich nie widzi – potrzebne VM.Backup)
  GET /nodes/<węzeł>/tasks/<upid>/log                           log zadania vzdump: które maszyny mają udaną kopię
Parsery są tolerancyjne: brak pola daje None, a nie błąd.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any
from urllib.parse import quote

import httpx


class ProxmoxError(Exception):
    """Błąd rozmowy z Proxmoxem (sieć, TLS, token, nieoczekiwana odpowiedź)."""


@dataclass(frozen=True)
class PveNode:
    name: str
    online: bool
    ip: str | None
    cpu_percent: float | None
    cpus: int | None
    mem_used: int | None
    mem_total: int | None
    disk_used: int | None  # system plików węzła (rootfs)
    disk_total: int | None
    uptime_s: int | None
    load: tuple[float, ...] = ()


@dataclass(frozen=True)
class PveGuest:
    vmid: int
    type: str  # qemu | lxc
    name: str
    node: str
    status: str  # running | stopped | paused …
    template: bool
    cpu_percent: float | None  # % przydzielonych rdzeni (100% = wszystkie vCPU maszyny)
    cpus: int | None
    mem_used: int | None
    mem_total: int | None
    disk_used: int | None  # tylko LXC podaje zajętość; VM ma tu 0
    disk_total: int | None
    uptime_s: int | None
    netin: int | None  # liczniki bajtów od startu maszyny
    netout: int | None
    diskread: int | None
    diskwrite: int | None
    tags: str | None = None

    @property
    def key(self) -> str:
        """Klucz w metrykach i alertach: czytelny i jednoznaczny („nextcloud (105)”)."""
        return f"{self.name} ({self.vmid})"


@dataclass(frozen=True)
class PveStorage:
    storage: str
    node: str
    type: str | None
    shared: bool
    active: bool
    content: tuple[str, ...]
    used: int | None
    total: int | None


@dataclass(frozen=True)
class PveTask:
    upid: str
    node: str
    vmid: str | None  # puste, gdy zadanie obejmuje kilka maszyn
    status: str | None  # "OK" albo opis błędu; None = trwa
    start: datetime | None
    end: datetime | None

    @property
    def ok(self) -> bool | None:
        if self.status is None:
            return None
        return self.status == "OK" or self.status.startswith("WARNINGS")


@dataclass(frozen=True)
class PveBackup:
    vmid: int
    created: datetime
    size: int | None


@dataclass
class PveSnapshot:
    version: str | None
    cluster: str | None
    nodes: list[PveNode] = field(default_factory=list)
    guests: list[PveGuest] = field(default_factory=list)
    storages: list[PveStorage] = field(default_factory=list)


def _int(v: Any) -> int | None:
    try:
        return int(v) if v is not None and v != "" else None
    except (TypeError, ValueError):
        return None


def _float(v: Any) -> float | None:
    try:
        return float(v) if v is not None and v != "" else None
    except (TypeError, ValueError):
        return None


def _str(v: Any) -> str | None:
    return str(v).strip() or None if v is not None else None


def _ts(v: Any) -> datetime | None:
    n = _int(v)
    return datetime.fromtimestamp(n, UTC) if n else None


def _pct(fraction: Any) -> float | None:
    f = _float(fraction)
    return None if f is None else round(max(0.0, f) * 100.0, 1)


def parse_cluster_status(data: list[dict]) -> tuple[str | None, dict[str, tuple[bool, str | None]]]:
    """`/cluster/status` → (nazwa klastra albo None dla pojedynczego węzła, {węzeł: (online, ip)})."""
    name = None
    nodes: dict[str, tuple[bool, str | None]] = {}
    for item in data or []:
        if item.get("type") == "cluster":
            name = _str(item.get("name"))
        elif item.get("type") == "node" and item.get("name"):
            nodes[str(item["name"])] = (bool(item.get("online", 1)), _str(item.get("ip")))
    return name, nodes


def parse_resources(data: list[dict], status: dict[str, tuple[bool, str | None]] | None = None) -> tuple[list[PveNode], list[PveGuest], list[PveStorage]]:
    status = status or {}
    nodes: list[PveNode] = []
    guests: list[PveGuest] = []
    storages: list[PveStorage] = []
    for r in data or []:
        kind = r.get("type")
        if kind == "node" and r.get("node"):
            name = str(r["node"])
            online = r.get("status") == "online" if "status" in r else status.get(name, (True, None))[0]
            nodes.append(
                PveNode(
                    name=name,
                    online=online,
                    ip=status.get(name, (online, None))[1],
                    cpu_percent=_pct(r.get("cpu")) if online else None,
                    cpus=_int(r.get("maxcpu")),
                    mem_used=_int(r.get("mem")) if online else None,
                    mem_total=_int(r.get("maxmem")),
                    disk_used=_int(r.get("disk")) if online else None,
                    disk_total=_int(r.get("maxdisk")),
                    uptime_s=_int(r.get("uptime")) if online else None,
                )
            )
        elif kind in ("qemu", "lxc") and r.get("vmid") is not None:
            vmid = _int(r.get("vmid"))
            if vmid is None:
                continue
            running = r.get("status") == "running"
            guests.append(
                PveGuest(
                    vmid=vmid,
                    type=kind,
                    name=_str(r.get("name")) or f"{'VM' if kind == 'qemu' else 'CT'} {vmid}",
                    node=str(r.get("node") or "?"),
                    status=_str(r.get("status")) or "unknown",
                    template=bool(_int(r.get("template"))),
                    cpu_percent=_pct(r.get("cpu")) if running else None,
                    cpus=_int(r.get("maxcpu")),
                    mem_used=_int(r.get("mem")) if running else None,
                    mem_total=_int(r.get("maxmem")),
                    disk_used=(_int(r.get("disk")) or None) if kind == "lxc" else None,
                    disk_total=_int(r.get("maxdisk")),
                    uptime_s=_int(r.get("uptime")) if running else None,
                    netin=_int(r.get("netin")) if running else None,
                    netout=_int(r.get("netout")) if running else None,
                    diskread=_int(r.get("diskread")) if running else None,
                    diskwrite=_int(r.get("diskwrite")) if running else None,
                    tags=_str(r.get("tags")),
                )
            )
        elif kind == "storage" and r.get("storage"):
            storages.append(
                PveStorage(
                    storage=str(r["storage"]),
                    node=str(r.get("node") or "?"),
                    type=_str(r.get("plugintype")),
                    shared=bool(_int(r.get("shared"))),
                    active=r.get("status") == "available",
                    content=tuple(c for c in str(r.get("content") or "").split(",") if c),
                    used=_int(r.get("disk")),
                    total=_int(r.get("maxdisk")),
                )
            )
    return nodes, guests, storages


def parse_load(data: dict) -> tuple[float, ...]:
    return tuple(v for v in (_float(x) for x in (data or {}).get("loadavg") or []) if v is not None)[:3]


def parse_tasks(data: list[dict], node: str) -> list[PveTask]:
    """Zadania vzdump od najnowszego."""
    tasks = [
        PveTask(
            upid=str(t.get("upid") or ""),
            node=str(t.get("node") or node),
            vmid=_str(t.get("id")),
            status=_str(t.get("status")),
            start=_ts(t.get("starttime")),
            end=_ts(t.get("endtime")),
        )
        for t in data or []
        if t.get("type") == "vzdump"
    ]
    return sorted(tasks, key=lambda t: t.start or datetime.min.replace(tzinfo=UTC), reverse=True)


_FINISHED_BACKUP = re.compile(r"Finished Backup of VM (\d+)")


def parse_task_log(lines: list[dict]) -> set[int]:
    """Maszyny, których kopia w zadaniu vzdump się udała (zadanie kilku maszyn ma puste `id`, więc tylko log to mówi)."""
    return {int(m.group(1)) for line in lines or [] if (m := _FINISHED_BACKUP.search(str(line.get("t") or "")))}


def parse_backups(data: list[dict]) -> list[PveBackup]:
    out = []
    for b in data or []:
        vmid, created = _int(b.get("vmid")), _ts(b.get("ctime"))
        if vmid is not None and created is not None and b.get("content", "backup") == "backup":
            out.append(PveBackup(vmid=vmid, created=created, size=_int(b.get("size"))))
    return out


class ProxmoxApi:
    def __init__(
        self,
        host: str,
        token_id: str,
        token_secret: str,
        *,
        port: int = 8006,
        verify_tls: bool = False,
        timeout: float = 10.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.base = f"https://{host}:{port}/api2/json"
        self._client = httpx.AsyncClient(
            headers={"Authorization": f"PVEAPIToken={token_id}={token_secret}", "Accept": "application/json"},
            verify=verify_tls,
            timeout=timeout,
            transport=transport,
        )

    async def _get(self, path: str, params: dict | None = None) -> Any:
        try:
            res = await self._client.get(self.base + path, params=params)
        except httpx.HTTPError as exc:
            raise ProxmoxError(f"Brak połączenia z Proxmox: {type(exc).__name__}: {exc}") from exc
        if res.status_code == 401:
            raise ProxmoxError("Proxmox odrzucił token API (sprawdź identyfikator tokenu i sekret)")
        if res.status_code == 403:
            raise ProxmoxError("Token nie ma uprawnień – nadaj mu rolę PVEAuditor na ścieżce / (Datacenter → Permissions)")
        if res.status_code != 200:
            raise ProxmoxError(f"Proxmox odpowiedział kodem {res.status_code} dla {path}")
        try:
            body = res.json()
        except ValueError as exc:
            raise ProxmoxError("Proxmox zwrócił odpowiedź, która nie jest JSON-em") from exc
        if not isinstance(body, dict) or "data" not in body:
            raise ProxmoxError("Nieoczekiwany format odpowiedzi Proxmox")
        return body["data"]

    async def version(self) -> str | None:
        return _str((await self._get("/version") or {}).get("version"))

    async def snapshot(self) -> PveSnapshot:
        version = await self.version()
        cluster, status = parse_cluster_status(await self._get("/cluster/status"))
        nodes, guests, storages = parse_resources(await self._get("/cluster/resources"), status)
        return PveSnapshot(version=version, cluster=cluster, nodes=nodes, guests=guests, storages=storages)

    async def node_load(self, node: str) -> tuple[float, ...]:
        return parse_load(await self._get(f"/nodes/{quote(node)}/status"))

    async def backup_tasks(self, node: str, limit: int = 20) -> list[PveTask]:
        return parse_tasks(await self._get(f"/nodes/{quote(node)}/tasks", {"typefilter": "vzdump", "limit": limit}), node)

    async def task_backed_up(self, node: str, upid: str) -> set[int]:
        """Maszyny z udaną kopią w zadaniu vzdump (z logu zadania; wystarczy rola PVEAuditor)."""
        return parse_task_log(await self._get(f"/nodes/{quote(node)}/tasks/{quote(upid, safe='')}/log", {"limit": 5000}))

    async def backups(self, node: str, storage: str) -> list[PveBackup]:
        return parse_backups(await self._get(f"/nodes/{quote(node)}/storage/{quote(storage)}/content", {"content": "backup"}))

    async def close(self) -> None:
        await self._client.aclose()
