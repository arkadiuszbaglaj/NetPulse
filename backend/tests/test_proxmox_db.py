"""Proxmox na bazie: kolektor (węzły jako urządzenia, maszyny, magazyny, kopie), API, alerty i wykresy.

Uruchamiane, gdy ustawiono NETPULSE_TEST_DB=1 i NETPULSE_DATABASE_URL (CI ma usługę bazy).
"""

from __future__ import annotations

import asyncio
import os
from datetime import UTC, datetime, timedelta

import pytest

if os.environ.get("NETPULSE_TEST_DB") != "1":
    pytest.skip("brak testowej bazy (NETPULSE_TEST_DB=1)", allow_module_level=True)

from fastapi.testclient import TestClient  # noqa: E402
from pve_fake import FakePve  # noqa: E402
from sqlalchemy import delete, func, select, update  # noqa: E402

from netpulse.alerts import AlertEngine  # noqa: E402
from netpulse.api import app  # noqa: E402
from netpulse.api.security import login_limiter  # noqa: E402
from netpulse.collector import Collector  # noqa: E402
from netpulse.db import Session, engine, init_db  # noqa: E402
from netpulse.db.models import (  # noqa: E402
    Alert,
    AlertRule,
    Device,
    DiskMetric,
    Metric,
    ProxmoxGuest,
    ProxmoxNode,
    ProxmoxServer,
    User,
)
from netpulse.proxmox import ProxmoxApi  # noqa: E402
from netpulse.proxmox_collector import ProxmoxCollector  # noqa: E402

ADMIN = {"username": "admin", "password": "haslo-testowe-1"}
SERVER = {"name": "Homelab", "host": "192.168.1.10", "token_id": "netpulse@pve!monitor", "token_secret": "secret-uuid-1234"}


def run(coro_fn):
    async def wrapper():
        try:
            return await coro_fn()
        finally:
            await engine.dispose()

    return asyncio.run(wrapper())


async def reset():
    await init_db()
    async with Session() as s, s.begin():
        await s.execute(delete(Alert))
        await s.execute(delete(AlertRule))
        await s.execute(delete(ProxmoxServer))
        await s.execute(delete(Device))
        await s.execute(delete(User))


@pytest.fixture
def client():
    run(reset)
    login_limiter._failures.clear()
    with TestClient(app) as c:
        assert c.post("/api/auth/setup", json=ADMIN).status_code == 201
        yield c
    run(reset)


def add_server(**kw) -> int:
    async def go():
        async with Session() as s, s.begin():
            srv = ProxmoxServer(**{**SERVER, **kw})
            s.add(srv)
            await s.flush()
            return srv.id

    return run(go)


def collector_for(fake: FakePve) -> ProxmoxCollector:
    return ProxmoxCollector(api_factory=lambda t: ProxmoxApi(t.host, t.token_id, t.token_secret, transport=fake.transport()))


def poll(collector: ProxmoxCollector) -> None:
    async def go():
        await collector.poll_all()

    run(go)


def test_poll_creates_node_devices_guests_storages_and_metrics(client):
    server_id = add_server()
    fake = FakePve()
    collector = collector_for(fake)
    poll(collector)
    poll(collector)  # drugi odczyt – szybkości z liczników

    devices = {d["name"]: d for d in client.get("/api/devices").json()}
    assert set(devices) == {"pve1", "pve2"}
    pve1 = devices["pve1"]
    assert pve1["driver"] == "proxmox" and pve1["kind"] == "server" and pve1["host"] == "192.168.1.10" and pve1["status"] == "up"

    server = client.get(f"/api/devices/{pve1['id']}/server").json()
    assert server["cpu_percent"] == 12.0 and server["mem_used_percent"] == 25.0 and server["load1"] == 0.52
    mounts = {d["mount"] for d in server["disks"]}
    assert {"/", "local (dir)", "local-lvm (lvmthin)", "nas-backup (nfs)"} <= mounts  # współdzielony przy pve1
    assert server["proxmox"]["guests_running"] == 2 and server["proxmox"]["guests_total"] == 3  # bez szablonu
    assert server["proxmox"]["backup_status"] == "OK" and server["proxmox"]["cluster"] == "homelab"
    pve2 = client.get(f"/api/devices/{devices['pve2']['id']}/server").json()
    assert pve2["proxmox"]["backup_status"] == "job errors"
    assert not any(d["mount"].startswith("nas-backup") for d in pve2["disks"])

    guests = {g["vmid"]: g for g in client.get("/api/proxmox/guests").json()}
    assert set(guests) == {100, 101, 105, 106, 9000}
    assert guests[105]["key"] == "nextcloud (105)" and guests[105]["device_id"] == pve1["id"]
    assert guests[106]["device_id"] == devices["pve2"]["id"]
    assert guests[100]["last_backup_at"] is not None and guests[101]["last_backup_at"] is None
    storages = client.get("/api/proxmox/storages").json()
    assert [(s["node"], s["storage"]) for s in storages].count(("pve1", "nas-backup")) == 1
    assert ("pve2", "nas-backup") not in [(s["node"], s["storage"]) for s in storages]

    async def metrics():
        async with Session() as s:
            rows = (await s.execute(select(Metric.name, Metric.key, Metric.value).order_by(Metric.time.desc()))).all()
        latest: dict = {}
        for name, key, value in rows:
            latest.setdefault((name, key), value)
        return latest

    m = run(metrics)
    assert m[("guest_up", "homeassistant (100)")] == 1.0 and m[("guest_up", "windows (101)")] == 0.0
    assert ("guest_up", "ubuntu-template (9000)") not in m  # szablony pomijamy
    assert m[("guest_net_rx_bps", "homeassistant (100)")] > 0
    assert m[("backup_task_ok", "vzdump")] in (0.0, 1.0)
    assert 1.9 <= m[("backup_age_h", "homeassistant (100)")] <= 2.1
    assert m[("backup_age_h", "pihole (106)")] >= 71

    # Wykres maszyny i lista maszyn do edytora wykresu
    keys = client.get(f"/api/devices/{pve1['id']}/agent-keys").json()["pve_guest"]
    assert "pihole (106)" in keys and "nextcloud (105)" in keys  # z całego klastra
    series = client.get(f"/api/devices/{pve1['id']}/agent-metrics", params={"source": "pve_guest", "key": "homeassistant (100)"}).json()
    assert series[-1]["values"]["guest_cpu_percent"] == 25.0
    assert series[-1]["values"]["rx_bps"] > 0

    # Kolektor SNMP nie odpytuje węzłów Proxmox
    async def snmp_targets():
        return {t.id for t in await Collector().load_targets()}

    assert pve1["id"] not in run(snmp_targets)
    assert server_id


def test_backup_age_from_tasks_when_token_cannot_list_backups(client):
    """Token z rolą PVEAuditor nie widzi plików kopii (prawdziwy PVE 9): wiek kopii z udanych zadań vzdump i ich logów."""
    add_server()
    fake = FakePve()
    fake.backups_visible = False
    collector = collector_for(fake)
    poll(collector)
    poll(collector)
    guests = {g["vmid"]: g for g in client.get("/api/proxmox/guests").json()}
    assert guests[100]["last_backup_at"] and guests[105]["last_backup_at"]  # z logu zadania kilku maszyn
    assert guests[106]["last_backup_at"] is None  # jedyne zadanie 106 skończyło się błędem
    assert guests[101]["last_backup_at"] is None

    async def ages():
        async with Session() as s:
            rows = (await s.execute(select(Metric.key, Metric.value).where(Metric.name == "backup_age_h"))).all()
        return {k: v for k, v in rows}

    got = run(ages)
    assert 1.9 <= got["homeassistant (100)"] <= 2.0 and 1.9 <= got["nextcloud (105)"] <= 2.0
    assert "pihole (106)" not in got
    logs = [c for c in fake.calls if c.endswith("/log")]
    assert logs == ["/nodes/pve1/tasks/UPID:pve1:1/log", "/nodes/pve1/tasks/UPID:pve1:0/log"]  # każdy log raz


def test_unreachable_server_marks_nodes_down(client):
    add_server()
    fake = FakePve()
    collector = collector_for(fake)
    poll(collector)
    fake.down = True
    poll(collector)
    servers = client.get("/api/proxmox/servers").json()
    assert servers[0]["status"] == "down" and "Brak połączenia" in servers[0]["last_error"]
    assert {d["status"] for d in client.get("/api/devices").json()} == {"down"}


def test_alerts_guest_stopped_backup_failed_and_stale_backup(client):
    add_server()
    fake = FakePve()
    collector = collector_for(fake)

    async def rules():
        async with Session() as s, s.begin():
            s.add_all(
                [
                    AlertRule(name="VM", kind="guest_stopped", duration_s=0, severity="warning"),
                    AlertRule(name="Kopia", kind="backup_failed", duration_s=0, severity="critical"),
                    AlertRule(name="Stara kopia", kind="metric", metric="backup_age_h", op=">", threshold=36.0, duration_s=0, severity="warning"),
                ]
            )

    run(rules)
    poll(collector)
    fake.guest_status[100] = "stopped"  # działała, zatrzymała się
    poll(collector)

    async def evaluate():
        await AlertEngine().evaluate()
        async with Session() as s:
            return sorted(a.title for a in (await s.scalars(select(Alert).where(Alert.state == "firing"))).all())

    titles = run(evaluate)
    assert "pve1: maszyna homeassistant (100) zatrzymana" in titles
    assert "pve1: maszyna windows (101) zatrzymana" not in titles  # zatrzymana od początku
    assert "pve2: kopia zapasowa vzdump zakończyła się błędem" in titles
    assert any(t.startswith("pve2: ostatnia kopia pihole (106)") for t in titles)
    assert not any("homeassistant" in t and "ostatnia kopia" in t for t in titles)


def test_server_api_crud_hides_secret_and_requires_admin(client):
    res = client.post("/api/proxmox/servers", params={"probe": "false"}, json=SERVER)
    assert res.status_code == 201, res.text
    body = res.json()
    assert "token_secret" not in body and body["port"] == 8006 and body["token_id"] == "netpulse@pve!monitor"
    assert client.post("/api/proxmox/servers", params={"probe": "false"}, json=SERVER).status_code == 409
    assert client.post("/api/proxmox/servers", params={"probe": "false"}, json={**SERVER, "host": "10.1.1.1", "token_id": "zly"}).status_code == 422
    sid = body["id"]
    assert client.patch(f"/api/proxmox/servers/{sid}", json={"name": "Lab", "enabled": False}).json()["name"] == "Lab"

    # Usunięcie serwera usuwa też urządzenia jego węzłów
    run_poll_once(sid)
    assert len(client.get("/api/devices").json()) == 2
    assert client.delete(f"/api/proxmox/servers/{sid}").status_code == 204
    assert client.get("/api/devices").json() == []

    async def counts():
        async with Session() as s:
            return await s.scalar(select(func.count()).select_from(ProxmoxNode)), await s.scalar(select(func.count()).select_from(ProxmoxGuest))

    assert run(counts) == (0, 0)


def run_poll_once(server_id: int) -> None:
    async def enable():
        async with Session() as s, s.begin():
            await s.execute(update(ProxmoxServer).where(ProxmoxServer.id == server_id).values(enabled=True))

    run(enable)
    poll(collector_for(FakePve()))


def test_node_ip_already_used_by_snmp_device_gets_other_host(client):
    async def snmp_device():
        async with Session() as s, s.begin():
            s.add(Device(name="pve1 (SNMP)", host="192.168.1.10", community="public"))

    run(snmp_device)
    add_server()
    poll(collector_for(FakePve()))
    hosts = {d["name"]: d["host"] for d in client.get("/api/devices").json()}
    assert hosts["pve1 (SNMP)"] == "192.168.1.10" and hosts["pve1"] == "pve1.proxmox" and hosts["pve2"] == "192.168.1.11"


def test_disk_metrics_are_written_per_storage(client):
    add_server()
    poll(collector_for(FakePve()))

    async def mounts():
        since = datetime.now(UTC) - timedelta(minutes=5)
        async with Session() as s:
            return set((await s.scalars(select(DiskMetric.mount).where(DiskMetric.time >= since))).all())

    assert {"/", "local (dir)", "local-lvm (lvmthin)", "nas-backup (nfs)"} <= run(mounts)
