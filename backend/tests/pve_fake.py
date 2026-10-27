"""Atrapa Proxmox VE API (format odpowiedzi jak w Proxmox VE 8, `/api2/json/...`), do testów bez sprzętu.

Klaster „homelab”: węzły pve1 (192.168.1.10) i pve2 (192.168.1.11). Na pve1: VM 100 homeassistant (działa),
VM 101 windows (zatrzymana), szablon 9000, LXC 105 nextcloud (działa); na pve2: LXC 106 pihole (działa).
Magazyny: local i local-lvm na każdym węźle, współdzielony nas-backup (NFS, kopie). Ostatnie zadanie vzdump:
pve1 OK, pve2 z błędem. Kopie: 100 i 105 sprzed 2 h, 106 sprzed 3 dni, 101 nigdy.
`backups_visible = False` udaje token z rolą PVEAuditor: magazyn nie pokazuje plików kopii (jak prawdziwy PVE 9),
zostają zadania vzdump i ich logi (zadanie pve1 sprzed 2 h: kopie 100 i 105).
"""

from __future__ import annotations

import json
import time
from urllib.parse import unquote

import httpx

GiB = 1024**3


class FakePve:
    def __init__(self, now: float | None = None) -> None:
        self.now = now or time.time()
        self.token_ok = True
        self.down = False
        self.counters = 0  # rośnie przy każdym odczycie zasobów (liczniki sieci i dysku maszyn)
        self.guest_status = {100: "running", 101: "stopped", 105: "running", 106: "running"}
        self.calls: list[str] = []
        self.backups_visible = True

    # --- odpowiedzi -------------------------------------------------------------------

    def resources(self) -> list[dict]:
        self.counters += 1
        c = self.counters
        node = lambda name, cpu, mem: {  # noqa: E731
            "id": f"node/{name}", "type": "node", "node": name, "status": "online", "cpu": cpu, "maxcpu": 8,
            "mem": mem, "maxmem": 32 * GiB, "disk": 10 * GiB, "maxdisk": 100 * GiB, "uptime": 864000,
        }  # fmt: skip

        def guest(vmid, kind, name, node_name, maxmem, extra=None):
            running = self.guest_status.get(vmid) == "running"
            g = {
                "id": f"{kind}/{vmid}", "type": kind, "vmid": vmid, "name": name, "node": node_name,
                "status": self.guest_status.get(vmid, "stopped"), "template": 0, "maxcpu": 2, "maxmem": maxmem,
                "maxdisk": 32 * GiB, "cpu": 0.25 if running else 0, "mem": maxmem // 2 if running else 0,
                "disk": 4 * GiB if kind == "lxc" else 0, "uptime": 3600 if running else 0,
                "netin": 1_000_000 * c, "netout": 500_000 * c, "diskread": 2_000_000 * c, "diskwrite": 1_000_000 * c,
            }  # fmt: skip
            g.update(extra or {})
            return g

        storage = lambda name, node_name, kind, content, used, total, shared=0: {  # noqa: E731
            "id": f"storage/{node_name}/{name}", "type": "storage", "storage": name, "node": node_name, "status": "available",
            "plugintype": kind, "content": content, "shared": shared, "disk": used, "maxdisk": total,
        }  # fmt: skip
        return [
            node("pve1", 0.12, 8 * GiB),
            node("pve2", 0.05, 4 * GiB),
            guest(100, "qemu", "homeassistant", "pve1", 4 * GiB),
            guest(101, "qemu", "windows", "pve1", 8 * GiB),
            guest(9000, "qemu", "ubuntu-template", "pve1", 2 * GiB, {"template": 1, "status": "stopped"}),
            guest(105, "lxc", "nextcloud", "pve1", 2 * GiB, {"tags": "web;prod"}),
            guest(106, "lxc", "pihole", "pve2", GiB),
            storage("local", "pve1", "dir", "iso,vztmpl,backup", 20 * GiB, 100 * GiB),
            storage("local-lvm", "pve1", "lvmthin", "images,rootdir", 300 * GiB, 400 * GiB),
            storage("local", "pve2", "dir", "iso,vztmpl", 5 * GiB, 100 * GiB),
            storage("nas-backup", "pve1", "nfs", "backup", 900 * GiB, 1000 * GiB, 1),
            storage("nas-backup", "pve2", "nfs", "backup", 900 * GiB, 1000 * GiB, 1),
        ]

    def route(self, path: str, params: dict) -> object:
        if path == "/version":
            return {"version": "8.2.4", "release": "8.2", "repoid": "faa83925"}
        if path == "/cluster/status":
            return [
                {"type": "cluster", "name": "homelab", "nodes": 2, "quorate": 1},
                {"type": "node", "name": "pve1", "online": 1, "ip": "192.168.1.10", "local": 1},
                {"type": "node", "name": "pve2", "online": 1, "ip": "192.168.1.11"},
            ]
        if path == "/cluster/resources":
            return self.resources()
        if path.startswith("/nodes/") and path.endswith("/status"):
            return {"loadavg": ["0.52", "0.40", "0.31"], "uptime": 864000}
        if path.startswith("/nodes/") and path.endswith("/tasks"):
            node = path.split("/")[2]
            day = 86400
            if node == "pve1":
                return [
                    {"upid": "UPID:pve1:1", "node": "pve1", "type": "vzdump", "id": "", "status": "OK", "starttime": int(self.now - 7200), "endtime": int(self.now - 7000)},
                    {"upid": "UPID:pve1:0", "node": "pve1", "type": "vzdump", "id": "", "status": "job errors", "starttime": int(self.now - day), "endtime": int(self.now - day + 300)},
                    {"upid": "UPID:pve1:x", "node": "pve1", "type": "qmstart", "id": "100", "status": "OK", "starttime": int(self.now - 60), "endtime": int(self.now - 59)},
                ]  # fmt: skip
            return [{"upid": "UPID:pve2:1", "node": "pve2", "type": "vzdump", "id": "106", "status": "job errors", "starttime": int(self.now - 7200), "endtime": int(self.now - 7100)}]  # fmt: skip
        if "/tasks/" in path and path.endswith("/log"):
            logs = {
                "UPID:pve1:1": ["INFO: Starting Backup of VM 100 (qemu)", "INFO: Finished Backup of VM 100 (00:03:12)",
                                "INFO: Starting Backup of VM 105 (lxc)", "INFO: Finished Backup of VM 105 (00:00:41)", "TASK OK"],
                "UPID:pve1:0": ["INFO: Finished Backup of VM 100 (00:03:02)", "ERROR: Backup of VM 105 failed - no space left",
                                "TASK ERROR: job errors"],
            }  # fmt: skip
            return [{"n": i, "t": line} for i, line in enumerate(logs.get(path.split("/")[4], ["TASK OK"]), start=1)]
        if "/storage/" in path and path.endswith("/content"):
            storage = path.split("/")[4]
            if storage == "nas-backup" and self.backups_visible:
                return [
                    {"volid": "nas-backup:backup/vzdump-qemu-100.vma.zst", "content": "backup", "vmid": 100, "ctime": int(self.now - 7100), "size": 5 * GiB},
                    {"volid": "nas-backup:backup/vzdump-lxc-105.tar.zst", "content": "backup", "vmid": 105, "ctime": int(self.now - 7050), "size": GiB},
                    {"volid": "nas-backup:backup/vzdump-lxc-106.tar.zst", "content": "backup", "vmid": 106, "ctime": int(self.now - 3 * 86400), "size": GiB // 2},
                    {"volid": "nas-backup:backup/vzdump-qemu-100-old.vma.zst", "content": "backup", "vmid": 100, "ctime": int(self.now - 5 * 86400), "size": 5 * GiB},
                ]  # fmt: skip
            return []
        raise KeyError(path)

    # --- transport httpx ----------------------------------------------------------------

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = unquote(request.url.path).removeprefix("/api2/json")
        self.calls.append(path)
        if self.down:
            raise httpx.ConnectError("Connection refused", request=request)
        if not self.token_ok or not request.headers.get("authorization", "").startswith("PVEAPIToken=netpulse@pve!monitor="):
            return httpx.Response(401, json={"data": None})
        try:
            data = self.route(path, dict(request.url.params))
        except KeyError:
            return httpx.Response(501, text=json.dumps({"data": None}))
        return httpx.Response(200, json={"data": data})

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handler)
