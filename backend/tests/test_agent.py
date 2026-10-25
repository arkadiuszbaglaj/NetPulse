"""Agent serwera Linux: odczyty z /proc i /sys na zrzutach, Docker, systemd, SMART, schemat raportu."""

from __future__ import annotations

import ast
import sys
from datetime import UTC, datetime
from pathlib import Path

import pytest

from netpulse.agent import netpulse_agent as agent
from netpulse.api.agents import AgentReport, agent_outdated, inventory, metric_rows

AGENT_FILE = Path(agent.__file__)

STAT_1 = """cpu  100 0 100 800 0 0 0 0 0 0
cpu0 50 0 50 400 0 0 0 0 0 0
cpu1 50 0 50 400 0 0 0 0 0 0
intr 12345
"""
STAT_2 = """cpu  200 0 150 850 0 0 0 0 0 0
cpu0 100 0 100 400 0 0 0 0 0 0
cpu1 50 0 50 500 0 0 0 0 0 0
"""

MEMINFO = """MemTotal:        8000000 kB
MemFree:          500000 kB
MemAvailable:    2000000 kB
Buffers:          100000 kB
Cached:          1000000 kB
SwapTotal:       1000000 kB
SwapFree:         750000 kB
"""

MOUNTS = """sysfs /sys sysfs rw 0 0
/dev/sda2 / ext4 rw,relatime 0 0
/dev/sda1 /boot/efi vfat rw 0 0
tmpfs /run tmpfs rw 0 0
/dev/loop0 /snap/core/1 squashfs ro 0 0
overlay /var/lib/docker/overlay2/x/merged overlay rw 0 0
/dev/sdb1 /mnt/dane\\040nas xfs rw 0 0
/dev/sda2 /var/lib/docker/btrfs ext4 rw 0 0
"""

DISKSTATS = """   8       0 sda 100 0 2000 0 50 0 4000 0 0 0 0
   8       1 sda1 10 0 200 0 5 0 400 0 0 0 0
 259       0 nvme0n1 10 0 1000 0 10 0 1000 0 0 0 0
 259       1 nvme0n1p1 10 0 1000 0 10 0 1000 0 0 0 0
   7       0 loop0 10 0 100 0 0 0 0 0 0 0 0
 179       0 mmcblk0 1 0 8 0 0 0 0 0 0 0 0
 179       1 mmcblk0p1 1 0 8 0 0 0 0 0 0 0 0
"""

NET_DEV = """Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1000 10 0 0 0 0 0 0 1000 10 0 0 0 0 0 0
  eth0: 5000 50 0 0 0 0 0 0 7000 70 0 0 0 0 0 0
docker0: 10 1 0 0 0 0 0 0 10 1 0 0 0 0 0 0
vethab12: 10 1 0 0 0 0 0 0 10 1 0 0 0 0 0 0
"""

SYSTEMCTL = """ssh.service                loaded    active   running OpenBSD Secure Shell server
cron.service               loaded    active   running Regular background program processing daemon
backup.service             loaded    failed   failed  Nightly backup
nginx.service              loaded    inactive dead    A high performance web server
ghost.service              not-found inactive dead    ghost.service
systemd-tmpfiles.timer     loaded    active   waiting Daily Cleanup
"""


def test_cpu_percent_total_and_per_core():
    prev, cur = agent.parse_cpu_times(STAT_1), agent.parse_cpu_times(STAT_2)
    assert set(cur) == {"cpu", "cpu0", "cpu1"}
    # razem: zajęte +150 z +200 jiffies
    assert agent.cpu_percent(prev, cur, "cpu") == 75.0
    assert agent.cpu_percent(prev, cur, "cpu0") == 100.0
    assert agent.cpu_percent(prev, cur, "cpu1") == 0.0
    assert agent.cpu_percent({}, cur, "cpu") is None


def test_memory_uses_available_and_swap():
    mem, total, swap = agent.memory(agent.parse_meminfo(MEMINFO))
    assert total == 8000000 * 1024
    assert mem == 75.0
    assert swap == 25.0
    assert agent.memory({}) == (None, None, None)


def test_mounts_only_real_disks():
    mounts = agent.parse_mounts(MOUNTS)
    assert [(m, fs) for _d, m, fs in mounts] == [("/", "ext4"), ("/boot/efi", "vfat"), ("/mnt/dane nas", "xfs")]


def test_diskstats_whole_disks_only():
    stats = agent.parse_diskstats(DISKSTATS)
    assert set(stats) == {"sda", "nvme0n1", "mmcblk0"}
    assert stats["sda"] == (2000 * 512, 4000 * 512)


def test_net_dev_skips_virtual_and_rates():
    prev = agent.parse_net_dev(NET_DEV)
    assert set(prev) == {"eth0"}
    cur = {"eth0": (6000, 6000)}  # licznik nadawania spadł (reset sterownika)
    assert agent.rates(prev, cur, 2.0) == {"eth0": (500.0, None)}
    assert agent.rates({}, cur, 2.0) == {"eth0": (None, None)}


def test_systemctl_counts_failed_and_watched():
    out = agent.parse_systemctl_units(SYSTEMCTL, {"nginx", "ghost"})
    assert out["running"] == 2
    assert out["failed"] == 1
    assert out["items"] == [
        {"name": "backup.service", "active": "failed", "sub": "failed"},
        {"name": "nginx.service", "active": "inactive", "sub": "dead"},
        {"name": "ghost.service", "active": "missing", "sub": "not-found"},
    ]


def test_container_cpu_and_memory():
    stats = {
        "cpu_stats": {"cpu_usage": {"total_usage": 3_000_000}, "system_cpu_usage": 20_000_000, "online_cpus": 4},
        "memory_stats": {"usage": 500, "stats": {"inactive_file": 200}},
    }
    prev = {"usage": 1_000_000, "system": 10_000_000}
    # 2 ms z 10 ms czasu systemu na 4 rdzeniach = 80% jednego rdzenia
    assert agent.container_cpu(prev, stats) == 80.0
    assert agent.container_cpu(None, stats) is None
    assert agent.container_mem(stats) == 300
    assert agent.container_mem({}) is None


def test_smartctl_ata_and_nvme():
    ata = agent.parse_smartctl(
        {
            "device": {"name": "/dev/sda"},
            "model_name": "WDC WD40EFRX",
            "smart_status": {"passed": True},
            "temperature": {"current": 34},
            "power_on_time": {"hours": 12000},
            "ata_smart_attributes": {"table": [{"id": 5, "raw": {"value": 2}}]},
        }
    )
    assert ata == {"device": "sda", "model": "WDC WD40EFRX", "passed": True, "temp_c": 34, "power_on_hours": 12000, "reallocated": 2}
    nvme = agent.parse_smartctl(
        {"device": {"name": "/dev/nvme0"}, "smart_status": {"passed": False}, "nvme_smart_health_information_log": {"media_errors": 7}}
    )
    assert nvme["passed"] is False and nvme["reallocated"] == 7 and nvme["model"] is None


def test_config_file_and_env(tmp_path, monkeypatch):
    conf = tmp_path / "agent.conf"
    conf.write_text("# komentarz\nNETPULSE_URL=http://np:8000\nNETPULSE_TOKEN='npa_x'\nSERVICES=nginx, ssh\n", encoding="utf-8")
    monkeypatch.setenv("SMART", "off")
    cfg = agent.load_config(str(conf))
    assert cfg["NETPULSE_URL"] == "http://np:8000"
    assert cfg["NETPULSE_TOKEN"] == "npa_x"
    assert cfg["SMART"] == "off"
    assert cfg["DOCKER"] == "auto"


def test_agent_runs_on_python_38():
    """Agent trafia na stare serwery (Ubuntu 20.04): bez składni nowszej niż 3.8."""
    tree = ast.parse(AGENT_FILE.read_text(encoding="utf-8"), feature_version=(3, 8))
    imports = {n.names[0].name.split(".")[0] for n in ast.walk(tree) if isinstance(n, ast.Import)}
    imports |= {n.module.split(".")[0] for n in ast.walk(tree) if isinstance(n, ast.ImportFrom) and n.module}
    # Tylko biblioteka standardowa
    assert imports <= set(sys.stdlib_module_names) | {"__future__"}, imports


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="odczyt /proc tylko na Linuksie")
def test_collect_on_this_machine_matches_api_schema():
    collector = agent.Collector({"DOCKER": "off", "SMART": "off"})
    report = collector.collect()
    parsed = AgentReport.model_validate(report)
    assert parsed.mem_used_percent is not None and parsed.disks
    assert metric_rows(parsed, 1, datetime.now(UTC)) is not None


def test_metric_rows_and_inventory():
    report = AgentReport.model_validate(
        {
            "agent_version": "0.11.0",
            "hostname": "nas",
            "cpu_cores": [10.0, 20.0],
            "load": [0.5, 0.4, 0.3],
            "disk_io": [{"device": "sda", "read_bps": 100.0, "write_bps": None}],
            "net": [{"iface": "eth0", "rx_bps": 8000.0, "tx_bps": 1600.0}],
            "temps": [{"sensor": "coretemp/Core 0", "celsius": 45.0}, {"sensor": "coretemp/Core 0", "celsius": 46.0}],
            "services": {"running": 20, "failed": 1, "items": [{"name": "backup.service", "active": "failed"}]},
            "containers": [{"name": "web", "state": "running", "cpu_percent": 3.5, "mem_bytes": 1000}, {"name": "old", "state": "exited"}],
            "smart": [{"device": "sda", "passed": True, "temp_c": 33}],
        }
    )
    rows = {(r["name"], r["key"]): r["value"] for r in metric_rows(report, 7, datetime.now(UTC))}
    assert rows[("cpu_core_percent", "cpu1")] == 20.0
    assert rows[("load15", "")] == 0.3
    assert ("disk_write_bps", "sda") not in rows
    assert rows[("net_rx_bps", "eth0")] == 8000.0
    assert rows[("temp_c", "coretemp/Core 0")] == 46.0  # powtórzony czujnik – zostaje ostatni
    assert rows[("service_up", "backup.service")] == 0.0
    assert rows[("services_failed", "")] == 1.0
    assert rows[("container_up", "web")] == 1.0 and rows[("container_up", "old")] == 0.0
    assert rows[("smart_ok", "sda")] == 1.0
    inv = inventory(report)
    assert inv["cpu_cores"] == 2
    assert inv["containers"][0]["name"] == "web"
    assert inv["disk_io"] == [{"device": "sda", "read_bps": 100.0, "write_bps": None}]
    assert inv["net"][0]["iface"] == "eth0"


def test_agent_outdated(monkeypatch):
    monkeypatch.setattr("netpulse.api.agents.__version__", "0.24.0")
    assert agent_outdated("0.11.0") and agent_outdated("0.23.9")
    assert not agent_outdated("0.24.0") and not agent_outdated("0.25.0") and not agent_outdated("1.0.0")
    assert agent_outdated("0.9.0")  # liczby, nie tekst: 0.9 < 0.24
    # Agent z repozytorium albo bez numeru – nie wiadomo, nie ostrzegamy
    assert not agent_outdated("dev") and not agent_outdated(None) and not agent_outdated("")


def test_report_limits():
    with pytest.raises(ValueError):
        AgentReport.model_validate({"agent_version": "x", "hostname": "h", "disks": [{"mount": "/", "total_bytes": 1, "used_bytes": 1}] * 65})
    with pytest.raises(ValueError):
        AgentReport.model_validate({"agent_version": "x", "hostname": ""})


def test_install_script_and_agent_are_served():
    from fastapi.testclient import TestClient

    from netpulse import __version__
    from netpulse.api import app

    with TestClient(app) as c:
        script = c.get("/agent/install.sh")
        assert script.status_code == 200
        assert "netpulse-agent.service" in script.text and "--token" in script.text
        program = c.get("/agent/netpulse-agent.py")
        assert program.status_code == 200
        assert f'VERSION = "{__version__}"' in program.text
        # Raport bez tokenu nie przechodzi (i nie potrzebuje bazy, żeby to stwierdzić)
        assert c.post("/api/agent/v1/report", json={"agent_version": "x", "hostname": "h"}).status_code == 401
