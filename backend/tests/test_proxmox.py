"""Klient Proxmox VE API i parsery – na atrapie API (bez sprzętu i bez bazy)."""

from __future__ import annotations

import asyncio

import pytest
from pve_fake import FakePve, GiB

from netpulse.proxmox import ProxmoxApi, ProxmoxError, parse_cluster_status, parse_resources, parse_tasks


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
