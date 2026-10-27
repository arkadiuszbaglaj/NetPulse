"""Klient Proxmox VE API i parsery – na atrapie API (bez sprzętu i bez bazy)."""

from __future__ import annotations

import asyncio

import pytest
from pve_fake import FakePve, GiB

from netpulse.proxmox import (
    ProxmoxApi,
    ProxmoxError,
    parse_cluster_status,
    parse_resources,
    parse_task_log,
    parse_tasks,
)


def api(fake: FakePve, secret: str = "secret-uuid-1234") -> ProxmoxApi:
    return ProxmoxApi("192.168.1.10", "netpulse@pve!monitor", secret, transport=fake.transport())


def run(coro):
    return asyncio.run(coro)


def test_snapshot_nodes_guests_storages():
    fake = FakePve()

    async def go():
        a = api(fake)
        try:
            return await a.snapshot()
        finally:
            await a.close()

    snap = run(go())
    assert snap.version == "8.2.4" and snap.cluster == "homelab"
    assert [(n.name, n.ip, n.online) for n in snap.nodes] == [("pve1", "192.168.1.10", True), ("pve2", "192.168.1.11", True)]
    pve1 = snap.nodes[0]
    assert pve1.cpu_percent == 12.0 and pve1.mem_used == 8 * GiB and pve1.cpus == 8
    guests = {g.vmid: g for g in snap.guests}
    assert guests[100].type == "qemu" and guests[100].status == "running" and guests[100].cpu_percent == 25.0
    assert guests[101].status == "stopped" and guests[101].cpu_percent is None and guests[101].netin is None
    assert guests[9000].template
    assert guests[105].type == "lxc" and guests[105].disk_used == 4 * GiB and guests[105].tags == "web;prod"
    assert guests[105].key == "nextcloud (105)"
    nas = [s for s in snap.storages if s.storage == "nas-backup"]
    assert len(nas) == 2 and all(s.shared and "backup" in s.content for s in nas)


def test_load_tasks_and_backups():
    fake = FakePve()

    async def go():
        a = api(fake)
        try:
            return await a.node_load("pve1"), await a.backup_tasks("pve1"), await a.backups("pve1", "nas-backup")
        finally:
            await a.close()

    load, tasks, backups = run(go())
    assert load == (0.52, 0.40, 0.31)
    assert [t.status for t in tasks] == ["OK", "job errors"]  # tylko vzdump, od najnowszego
    assert tasks[0].ok is True and tasks[1].ok is False
    assert {b.vmid for b in backups} == {100, 105, 106}
    assert any(c.startswith("/nodes/pve1/tasks") for c in fake.calls)


def test_errors_are_readable():
    fake = FakePve()
    fake.token_ok = False

    async def call(f):
        a = api(f)
        try:
            await a.version()
        finally:
            await a.close()

    with pytest.raises(ProxmoxError, match="token API"):
        run(call(fake))
    fake.token_ok, fake.down = True, True
    with pytest.raises(ProxmoxError, match="Brak połączenia"):
        run(call(fake))


def test_parsers_tolerate_missing_fields():
    name, nodes = parse_cluster_status([{"type": "node", "name": "solo", "online": 1}])
    assert name is None and nodes == {"solo": (True, None)}
    n, g, s = parse_resources([{"type": "node", "node": "solo", "status": "offline"}, {"type": "qemu", "vmid": "x"}, {"type": "lxc", "vmid": 200}])
    assert n[0].online is False and n[0].cpu_percent is None
    assert len(g) == 1 and g[0].name == "CT 200" and g[0].status == "unknown"
    assert s == []
    assert parse_tasks([{"type": "vzdump", "status": None}], "solo")[0].ok is None  # trwa
    warn = parse_tasks([{"type": "vzdump", "status": "WARNINGS: 1"}], "solo")[0]
    assert warn.ok is True


def test_parsers_real_pve91_single_node():
    """Odpowiedzi prawdziwego Proxmox VE 9.1.1 (jeden węzeł bez klastra, zatrzymana VM, zasób SDN „network”)."""
    name, status = parse_cluster_status([{"type": "node", "name": "pve", "nodeid": 0, "online": 1, "local": 1, "level": "", "id": "node/pve", "ip": "192.168.1.86"}])
    assert name is None and status == {"pve": (True, "192.168.1.86")}
    resources = [
        {"id": "qemu/100", "type": "qemu", "vmid": 100, "name": "ubuntu", "node": "pve", "status": "stopped", "template": 0, "cpu": 0, "maxcpu": 4,
         "mem": 0, "memhost": 0, "maxmem": 2147483648, "disk": 0, "maxdisk": 34359738368, "uptime": 0, "netin": 0, "netout": 0, "diskread": 0, "diskwrite": 0},
        {"id": "node/pve", "type": "node", "node": "pve", "status": "online", "level": "", "cgroup-mode": 2, "cpu": 0.00123915737298637, "maxcpu": 8,
         "mem": 1620881408, "maxmem": 8200138752, "disk": 6919643136, "maxdisk": 100861726720, "uptime": 777},
        {"id": "storage/pve/local", "type": "storage", "storage": "local", "node": "pve", "status": "available", "plugintype": "dir", "shared": 0,
         "content": "vztmpl,import,backup,iso", "disk": 6919643136, "maxdisk": 100861726720},
        {"id": "storage/pve/local-lvm", "type": "storage", "storage": "local-lvm", "node": "pve", "status": "available", "plugintype": "lvmthin", "shared": 0,
         "content": "images,rootdir", "disk": 7890023953, "maxdisk": 373934784512},
        {"id": "network/pve/localnetwork", "type": "network", "network-type": "zone", "network": "localnetwork", "node": "pve", "status": "ok"},
    ]  # fmt: skip
    nodes, guests, storages = parse_resources(resources, status)
    assert [(n.name, n.online, n.ip, n.cpus, n.uptime_s) for n in nodes] == [("pve", True, "192.168.1.86", 8, 777)]
    assert nodes[0].cpu_percent == pytest.approx(0.1, abs=0.05)
    vm = guests[0]
    assert len(guests) == 1 and (vm.vmid, vm.type, vm.status, vm.cpus, vm.mem_total) == (100, "qemu", "stopped", 4, 2147483648)
    assert vm.cpu_percent is None and vm.mem_used is None and vm.uptime_s is None  # zatrzymana: zera z API to brak danych
    assert {s.storage: (s.type, "backup" in s.content) for s in storages} == {"local": ("dir", True), "local-lvm": ("lvmthin", False)}


def test_parsers_real_pve91_running_vm():
    """Uruchomiona VM z prawdziwego Proxmox VE 9.1.1 (pole `memhost` PVE 9 pomijane, `disk` VM zawsze 0)."""
    vm = {"id": "qemu/100", "type": "qemu", "vmid": 100, "name": "ubuntu", "node": "pve", "status": "running", "template": 0, "cpu": 0.165878419011636,
          "maxcpu": 4, "mem": 1709981696, "memhost": 1867993088, "maxmem": 2147483648, "disk": 0, "maxdisk": 34359738368, "uptime": 53,
          "netin": 5376237, "netout": 200262, "diskread": 964870754, "diskwrite": 37950464}  # fmt: skip
    _, guests, _ = parse_resources([vm])
    g = guests[0]
    assert (g.status, g.cpus, g.mem_used, g.uptime_s, g.netin, g.netout) == ("running", 4, 1709981696, 53, 5376237, 200262)
    assert g.cpu_percent == pytest.approx(16.6, abs=0.1) and g.diskread == 964870754 and g.disk_used is None


def test_parsers_real_pve92_lxc():
    """Kontener LXC z prawdziwego Proxmox VE 9.2.24 – w przeciwieństwie do VM podaje zajętość dysku."""
    ct = {"type": "lxc", "id": "lxc/101", "vmid": 101, "name": "CT101", "node": "pve", "status": "running", "template": 0, "cpu": 0.00237540955359101,
          "maxcpu": 1, "mem": 15765504, "memhost": 0, "maxmem": 536870912, "disk": 357367808, "maxdisk": 8350298112, "uptime": 86,
          "netin": 28725, "netout": 796, "diskread": 251265024, "diskwrite": 4276224}  # fmt: skip
    _, guests, _ = parse_resources([ct])
    g = guests[0]
    assert (g.vmid, g.type, g.name, g.status, g.cpus, g.mem_used, g.mem_total) == (101, "lxc", "CT101", "running", 1, 15765504, 536870912)
    assert (g.disk_used, g.disk_total, g.uptime_s, g.netin) == (357367808, 8350298112, 86, 28725)
    assert g.cpu_percent == pytest.approx(0.2, abs=0.05)


def test_parse_task_log_real_pve92():
    """Log zadania vzdump z prawdziwego Proxmox VE 9.2.24 (kopia LXC 101) i zadanie kilku maszyn z błędem jednej."""
    real = [
        {"n": 1, "t": "INFO: starting new backup job: vzdump 101 --remove 0 --mode snapshot --node pve --compress zstd --storage local"},
        {"n": 2, "t": "INFO: Starting Backup of VM 101 (lxc)"},
        {"n": 13, "t": "INFO: creating vzdump archive '/var/lib/vz/dump/vzdump-lxc-101-2026_10_27-23_47_25.tar.zst'"},
        {"n": 19, "t": "INFO: Finished Backup of VM 101 (00:00:03)"},
        {"n": 21, "t": "INFO: Backup job finished successfully"},
        {"n": 23, "t": "TASK OK"},
    ]
    assert parse_task_log(real) == {101}
    mixed = [{"t": "INFO: Finished Backup of VM 100 (00:03:02)"}, {"t": "ERROR: Backup of VM 105 failed - no space left"}]
    assert parse_task_log(mixed) == {100} and parse_task_log([]) == set()
    (task,) = parse_tasks(
        [{"upid": "UPID:pve:00001D06:0002661A:6AE129FC:vzdump:101:root@pam:", "type": "vzdump", "id": "101", "status": "OK",
          "node": "pve", "user": "root@pam", "starttime": 1793141244, "endtime": 1793141248, "pid": 7430, "pstart": 157210}],
        "pve",
    )  # fmt: skip
    assert (task.vmid, task.ok) == ("101", True) and task.end and (task.end - task.start).total_seconds() == 4
