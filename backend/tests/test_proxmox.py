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
