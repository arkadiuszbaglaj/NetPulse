#!/usr/bin/env python3
"""NetPulse Agent – metryki serwera Linux wysyłane do NetPulse (push, HTTPS albo HTTP w sieci domowej).

Jeden plik, tylko biblioteka standardowa Pythona 3.8+ (Ubuntu 20.04 i nowsze, Debian 11 i nowsze).
Czyta /proc i /sys, opcjonalnie systemctl, gniazdo Dockera (tylko odczyt) i smartctl. Bez logów i śledzenia procesów.

Konfiguracja: /etc/netpulse-agent.conf (KLUCZ=wartość), zapisuje ją instalator:
    NETPULSE_URL=http://192.168.1.10:8000
    NETPULSE_TOKEN=npa_...
    SERVICES=nginx,ssh          # usługi systemd obserwowane zawsze (niedziałające i tak są raportowane)
    DOCKER=auto                 # auto | off
    SMART=auto                  # auto | off (wymaga smartmontools)
    VERIFY_TLS=1

Uruchomienie: `netpulse-agent.py` (pętla, usługa systemd) albo `netpulse-agent.py --once` (jeden raport, test).
"""

from __future__ import annotations

import argparse
import http.client
import json
import logging
import os
import re
import shutil
import socket
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.request

VERSION = "dev"  # podmieniane przez serwer przy pobieraniu
CONFIG_PATH = "/etc/netpulse-agent.conf"
DEFAULT_INTERVAL = 30
SMART_EVERY_S = 1800  # SMART zmienia się wolno, a odczyt budzi dyski
DOCKER_SOCKET = "/var/run/docker.sock"

REAL_FS = {"ext2", "ext3", "ext4", "xfs", "btrfs", "zfs", "vfat", "f2fs", "ntfs", "ntfs3", "exfat", "jfs", "reiserfs", "bcachefs"}
SKIP_MOUNT_PREFIXES = ("/snap/", "/var/lib/docker/", "/var/snap/", "/run/")
# Całe dyski (bez partycji): sda, vdb, nvme0n1, mmcblk0, md0
WHOLE_DISK_RE = re.compile(r"^(?:(?:sd|vd|xvd|hd)[a-z]+|nvme\d+n\d+|mmcblk\d+|md\d+)$")
NET_SKIP_PREFIXES = ("lo", "veth", "docker", "br-", "virbr", "cni", "flannel", "cali", "kube", "tap", "dummy")

log = logging.getLogger("netpulse-agent")


# --- konfiguracja -------------------------------------------------------------------


def load_config(path: str = CONFIG_PATH) -> dict:
    cfg = {"NETPULSE_URL": "", "NETPULSE_TOKEN": "", "SERVICES": "", "DOCKER": "auto", "SMART": "auto", "VERIFY_TLS": "1"}
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                cfg[key.strip()] = value.strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    for key in list(cfg):
        if os.environ.get(key):
            cfg[key] = os.environ[key]
    return cfg


def _read(path: str) -> str | None:
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return None


# --- odczyty z /proc i /sys (czyste funkcje: tekst → wartości, testowane na zrzutach) ---


def parse_cpu_times(stat: str) -> dict[str, tuple[int, int]]:
    """/proc/stat → {"cpu": (zajęty, razem), "cpu0": …} w jednostkach jiffies."""
    out = {}
    for line in stat.splitlines():
        if not line.startswith("cpu"):
            continue
        parts = line.split()
        values = [int(v) for v in parts[1:]]
        # user nice system idle iowait irq softirq steal (guest liczony już w user)
        total = sum(values[:8])
        idle = values[3] + (values[4] if len(values) > 4 else 0)
        out[parts[0]] = (total - idle, total)
    return out


def cpu_percent(prev: dict, cur: dict, name: str) -> float | None:
    if name not in prev or name not in cur:
        return None
    busy = cur[name][0] - prev[name][0]
    total = cur[name][1] - prev[name][1]
    if total <= 0:
        return None
    return round(max(0.0, min(100.0, 100.0 * busy / total)), 1)


def parse_meminfo(text: str) -> dict[str, int]:
    """/proc/meminfo → bajty."""
    out = {}
    for line in text.splitlines():
        key, _, rest = line.partition(":")
        parts = rest.split()
        if parts and parts[0].isdigit():
            out[key] = int(parts[0]) * (1024 if len(parts) > 1 and parts[1] == "kB" else 1)
    return out


def memory(info: dict[str, int]) -> tuple[float | None, int | None, float | None]:
    total = info.get("MemTotal")
    if not total:
        return None, None, None
    available = info.get("MemAvailable", info.get("MemFree", 0) + info.get("Buffers", 0) + info.get("Cached", 0))
    mem = round(100.0 * (total - available) / total, 1)
    swap_total = info.get("SwapTotal", 0)
    swap = round(100.0 * (swap_total - info.get("SwapFree", 0)) / swap_total, 1) if swap_total else None
    return mem, total, swap


def parse_mounts(text: str) -> list[tuple[str, str, str]]:
    """/proc/mounts → [(urządzenie, punkt montowania, system plików)] tylko prawdziwe dyski, bez powtórzeń."""
    seen, out = set(), []
    for line in text.splitlines():
        parts = line.split()
        if len(parts) < 3:
            continue
        dev, mount, fs = parts[0], parts[1].replace("\\040", " "), parts[2]
        if fs not in REAL_FS or mount.startswith(SKIP_MOUNT_PREFIXES) or dev in seen:
            continue
        seen.add(dev)
        out.append((dev, mount, fs))
    return out


def parse_diskstats(text: str) -> dict[str, tuple[int, int]]:
    """/proc/diskstats → {dysk: (bajty odczytane, bajty zapisane)} tylko całe dyski (bez partycji)."""
    out = {}
    for line in text.splitlines():
        parts = line.split()
        if len(parts) < 10:
            continue
        name = parts[2]
        if not WHOLE_DISK_RE.match(name):
            continue
        out[name] = (int(parts[5]) * 512, int(parts[9]) * 512)
    return out


def parse_net_dev(text: str) -> dict[str, tuple[int, int]]:
    """/proc/net/dev → {interfejs: (bajty odebrane, bajty wysłane)} bez interfejsów wirtualnych."""
    out = {}
    for line in text.splitlines()[2:]:
        name, _, rest = line.partition(":")
        name = name.strip()
        parts = rest.split()
        if not name or len(parts) < 9 or name.startswith(NET_SKIP_PREFIXES):
            continue
        out[name] = (int(parts[0]), int(parts[8]))
    return out


def rates(prev: dict, cur: dict, dt: float) -> dict[str, tuple[float | None, float | None]]:
    """Różnice par liczników → przyrost na sekundę (w jednostkach liczników, tu: bajty)."""
    out = {}
    for key, (a, b) in cur.items():
        if key in prev and dt > 0:
            pa, pb = prev[key]
            # Reset licznika (restart sterownika) – brak wartości zamiast ujemnej
            out[key] = (round((a - pa) / dt, 1) if a >= pa else None, round((b - pb) / dt, 1) if b >= pb else None)
        else:
            out[key] = (None, None)
    return out


def read_temps(root: str = "/sys/class") -> list[dict]:
    temps = []
    hwmon = os.path.join(root, "hwmon")
    for hw in sorted(os.listdir(hwmon)) if os.path.isdir(hwmon) else []:
        base = os.path.join(hwmon, hw)
        chip = (_read(os.path.join(base, "name")) or hw).strip()
        for entry in sorted(os.listdir(base)):
            if not (entry.startswith("temp") and entry.endswith("_input")):
                continue
            raw = _read(os.path.join(base, entry))
            if raw is None or not raw.strip().lstrip("-").isdigit():
                continue
            label = (_read(os.path.join(base, entry.replace("_input", "_label"))) or entry.split("_")[0]).strip()
            value = int(raw) / 1000.0
            if -40 < value < 150:
                temps.append({"sensor": f"{chip}/{label}"[:128], "celsius": round(value, 1)})
    if not temps:
        thermal = os.path.join(root, "thermal")
        for zone in sorted(os.listdir(thermal)) if os.path.isdir(thermal) else []:
            if not zone.startswith("thermal_zone"):
                continue
            raw = _read(os.path.join(thermal, zone, "temp"))
            kind = (_read(os.path.join(thermal, zone, "type")) or zone).strip()
            if raw and raw.strip().lstrip("-").isdigit():
                temps.append({"sensor": kind[:128], "celsius": round(int(raw) / 1000.0, 1)})
    return temps[:128]


def os_name() -> str | None:
    text = _read("/etc/os-release") or ""
    for line in text.splitlines():
        if line.startswith("PRETTY_NAME="):
            return line.split("=", 1)[1].strip().strip('"')[:128]
    return None


def process_count() -> int:
    return sum(1 for p in os.listdir("/proc") if p.isdigit())


# --- systemd, Docker, SMART (opcjonalne) -------------------------------------------------


def parse_systemctl_units(text: str, watched: set[str]) -> dict:
    """`systemctl list-units --type=service --all --plain --no-legend` → liczniki i lista usług: wszystkie załadowane
    poza nieaktywnymi (te są normalne, np. jednorazowe), a z nieaktywnych – z błędem i obserwowane (SERVICES)."""
    running = failed = 0
    items = []
    for line in text.splitlines():
        parts = line.split(None, 4)
        if len(parts) < 4 or not parts[0].endswith(".service"):
            continue
        unit, load, active, sub = parts[:4]
        is_watched = unit in watched or unit[: -len(".service")] in watched
        if load == "not-found":
            if is_watched:
                items.append({"name": unit, "active": "missing", "sub": "not-found", "watched": True})
            continue
        if sub == "running":
            running += 1
        if active == "failed":
            failed += 1
        if active != "inactive" or is_watched:
            items.append({"name": unit[:255], "active": active[:64], "sub": sub[:64], "watched": is_watched})
    # Przy limicie najpierw usługi z błędem i obserwowane – od nich zależą alerty
    items.sort(key=lambda s: not (s["active"] in ("failed", "missing") or s["watched"]))
    return {"running": running, "failed": failed, "items": items[:300]}


def parse_systemctl_show(text: str, now_monotonic_us: int) -> dict[str, dict]:
    """`systemctl show -p Id,MemoryCurrent,ActiveEnterTimestampMonotonic <usługi>` → pamięć i czas działania usług.
    Bloki właściwości oddziela pusta linia; „[not set]” i wartości spoza zakresu (brak rozliczania pamięci) pomijamy."""
    out: dict[str, dict] = {}
    for block in text.split("\n\n"):
        props = dict(line.split("=", 1) for line in block.splitlines() if "=" in line)
        unit = props.get("Id")
        if not unit:
            continue
        info = {}
        mem = props.get("MemoryCurrent", "")
        if mem.isdigit() and int(mem) < 2**63 - 1:
            info["mem_bytes"] = int(mem)
        since = props.get("ActiveEnterTimestampMonotonic", "")
        if since.isdigit() and 0 < int(since) <= now_monotonic_us:
            info["uptime_s"] = (now_monotonic_us - int(since)) // 1_000_000
        out[unit] = info
    return out


def read_services(watched: set[str]) -> dict | None:
    if not shutil.which("systemctl"):
        return None
    try:
        out = subprocess.run(
            ["systemctl", "list-units", "--type=service", "--all", "--plain", "--no-legend", "--no-pager"],
            capture_output=True, text=True, timeout=10, check=False,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    services = parse_systemctl_units(out, watched)
    active = [s["name"] for s in services["items"] if s["active"] == "active"]
    if active:
        try:
            show = subprocess.run(
                ["systemctl", "show", "-p", "Id,MemoryCurrent,ActiveEnterTimestampMonotonic", "--no-pager", *active],
                capture_output=True, text=True, timeout=10, check=False,
            ).stdout
            # CLOCK_MONOTONIC – ten sam zegar co znaczniki systemd
            details = parse_systemctl_show(show, int(time.monotonic() * 1_000_000))
        except (OSError, subprocess.SubprocessError):
            details = {}
        for s in services["items"]:
            s.update(details.get(s["name"], {}))
    return services


class _UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, path: str, timeout: float = 5.0) -> None:
        super().__init__("localhost", timeout=timeout)
        self._path = path

    def connect(self) -> None:
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self._path)


def docker_get(path: str, socket_path: str = DOCKER_SOCKET):
    conn = _UnixHTTPConnection(socket_path)
    try:
        conn.request("GET", path)
        res = conn.getresponse()
        body = res.read()
        if res.status != 200:
            raise OSError(f"Docker API {res.status}")
        return json.loads(body)
    finally:
        conn.close()


def container_cpu(prev: dict | None, stats: dict) -> float | None:
    """Procent CPU kontenera z dwóch kolejnych odczytów (100% = jeden rdzeń, jak `docker stats`)."""
    if not prev:
        return None
    cpu = stats.get("cpu_stats") or {}
    usage = (cpu.get("cpu_usage") or {}).get("total_usage")
    system = cpu.get("system_cpu_usage")
    pusage, psystem = prev.get("usage"), prev.get("system")
    if None in (usage, system, pusage, psystem) or system <= psystem:
        return None
    cpus = cpu.get("online_cpus") or len((cpu.get("cpu_usage") or {}).get("percpu_usage") or []) or 1
    return round(max(0.0, (usage - pusage) / (system - psystem) * cpus * 100.0), 1)


def container_mem(stats: dict) -> int | None:
    mem = stats.get("memory_stats") or {}
    usage = mem.get("usage")
    if usage is None:
        return None
    detail = mem.get("stats") or {}
    # Pamięć podręczna plików nie jest „zajęta” (cgroup v2: inactive_file, v1: total_inactive_file)
    return max(0, usage - detail.get("inactive_file", detail.get("total_inactive_file", 0)))


class DockerReader:
    def __init__(self, socket_path: str = DOCKER_SOCKET) -> None:
        self.socket_path = socket_path
        self._prev: dict[str, dict] = {}

    def available(self) -> bool:
        return os.path.exists(self.socket_path)

    def read(self, max_stats: int = 50) -> list[dict] | None:
        try:
            containers = docker_get("/containers/json?all=1", self.socket_path)
        except (OSError, ValueError, http.client.HTTPException) as exc:
            log.debug("Docker niedostępny: %s", exc)
            return None
        out, seen = [], {}
        for c in containers[:500]:
            name = ((c.get("Names") or ["?"])[0]).lstrip("/")
            item = {"name": name[:255], "image": (c.get("Image") or "")[:255] or None,
                    "state": (c.get("State") or "unknown")[:64], "status": (c.get("Status") or "")[:64] or None}
            if item["state"] == "running" and len(seen) < max_stats:
                try:
                    stats = docker_get(f"/containers/{c['Id']}/stats?stream=false&one-shot=true", self.socket_path)
                    cpu = stats.get("cpu_stats") or {}
                    item["cpu_percent"] = container_cpu(self._prev.get(c["Id"]), stats)
                    item["mem_bytes"] = container_mem(stats)
                    seen[c["Id"]] = {"usage": (cpu.get("cpu_usage") or {}).get("total_usage"), "system": cpu.get("system_cpu_usage")}
                except (OSError, ValueError, KeyError, http.client.HTTPException):
                    pass
            out.append(item)
        self._prev = seen
        return out


def parse_smartctl(data: dict) -> dict:
    dev = data.get("device") or {}
    attrs = {a.get("id"): a for a in (data.get("ata_smart_attributes") or {}).get("table") or []}
    realloc = (attrs.get(5) or {}).get("raw", {}).get("value")
    nvme = data.get("nvme_smart_health_information_log") or {}
    return {
        "device": (dev.get("name") or "?").replace("/dev/", "")[:64],
        "model": (data.get("model_name") or "")[:128] or None,
        "passed": (data.get("smart_status") or {}).get("passed"),
        "temp_c": (data.get("temperature") or {}).get("current"),
        "power_on_hours": (data.get("power_on_time") or {}).get("hours"),
        "reallocated": realloc if realloc is not None else nvme.get("media_errors"),
    }


def read_smart() -> list[dict] | None:
    if not shutil.which("smartctl") or os.geteuid() != 0:
        return None
    try:
        scan = json.loads(subprocess.run(["smartctl", "--scan", "-j"], capture_output=True, text=True, timeout=20).stdout or "{}")
    except (OSError, subprocess.SubprocessError, ValueError):
        return None
    out = []
    for d in (scan.get("devices") or [])[:32]:
        try:
            res = subprocess.run(["smartctl", "-j", "-H", "-A", "-i", "-n", "standby", d["name"]],
                                 capture_output=True, text=True, timeout=30)
            data = json.loads(res.stdout or "{}")
        except (OSError, subprocess.SubprocessError, ValueError, KeyError):
            continue
        if data.get("device"):
            out.append(parse_smartctl(data))
    return out


# --- zbieranie i wysyłka -----------------------------------------------------------------


class Collector:
    def __init__(self, cfg: dict) -> None:
        self.watched = {s.strip() for s in cfg.get("SERVICES", "").split(",") if s.strip()}
        self.docker = DockerReader() if cfg.get("DOCKER", "auto") != "off" else None
        self.smart_enabled = cfg.get("SMART", "auto") != "off"
        self._smart: list[dict] | None = None
        self._smart_at = 0.0
        self._prev_time = time.monotonic()
        self._prev_cpu = parse_cpu_times(_read("/proc/stat") or "")
        self._prev_disk = parse_diskstats(_read("/proc/diskstats") or "")
        self._prev_net = parse_net_dev(_read("/proc/net/dev") or "")

    def collect(self) -> dict:
        now = time.monotonic()
        dt = now - self._prev_time
        cpu = parse_cpu_times(_read("/proc/stat") or "")
        disk = parse_diskstats(_read("/proc/diskstats") or "")
        net = parse_net_dev(_read("/proc/net/dev") or "")
        cores = sorted((k for k in cpu if k != "cpu"), key=lambda k: int(k[3:]))
        mem, mem_total, swap = memory(parse_meminfo(_read("/proc/meminfo") or ""))
        disks = []
        for _dev, mount, fs in parse_mounts(_read("/proc/mounts") or ""):
            try:
                st = os.statvfs(mount)
            except OSError:
                continue
            total = st.f_blocks * st.f_frsize
            if total:
                disks.append({"mount": mount[:255], "fs": fs, "total_bytes": total, "used_bytes": (st.f_blocks - st.f_bfree) * st.f_frsize})
        uptime = (_read("/proc/uptime") or "0").split()[0]
        report = {
            "agent_version": VERSION,
            "hostname": socket.gethostname()[:255] or "linux",
            "os": os_name(),
            "kernel": os.uname().release[:64],
            "uptime_s": float(uptime),
            "cpu_percent": cpu_percent(self._prev_cpu, cpu, "cpu"),
            "cpu_cores": [p for p in (cpu_percent(self._prev_cpu, cpu, c) for c in cores) if p is not None][:512],
            "load": [float(v) for v in (_read("/proc/loadavg") or "0 0 0").split()[:3]],
            "mem_used_percent": mem,
            "mem_total_bytes": mem_total,
            "swap_used_percent": swap,
            "processes": process_count(),
            "disks": disks[:64],
            "disk_io": [{"device": k, "read_bps": r, "write_bps": w} for k, (r, w) in rates(self._prev_disk, disk, dt).items()][:64],
            "net": [
                {"iface": k, "rx_bps": None if rx is None else rx * 8, "tx_bps": None if tx is None else tx * 8}
                for k, (rx, tx) in rates(self._prev_net, net, dt).items()
            ][:64],
            "temps": read_temps(),
            "services": read_services(self.watched),
            "containers": self.docker.read() if self.docker and self.docker.available() else None,
            "smart": self.smart(),
        }
        self._prev_time, self._prev_cpu, self._prev_disk, self._prev_net = now, cpu, disk, net
        return report

    def smart(self) -> list[dict] | None:
        if not self.smart_enabled:
            return None
        if self._smart is None or time.monotonic() - self._smart_at > SMART_EVERY_S:
            self._smart = read_smart()
            self._smart_at = time.monotonic()
        return self._smart


class SendError(Exception):
    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


def send(cfg: dict, report: dict) -> dict:
    url = cfg["NETPULSE_URL"].rstrip("/") + "/api/agent/v1/report"
    req = urllib.request.Request(
        url,
        data=json.dumps(report).encode(),
        method="POST",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {cfg['NETPULSE_TOKEN']}",
                 "User-Agent": f"netpulse-agent/{VERSION}"},
    )
    context = None
    if url.startswith("https") and cfg.get("VERIFY_TLS", "1") in ("0", "false", "no"):
        context = ssl._create_unverified_context()
    try:
        with urllib.request.urlopen(req, timeout=15, context=context) as res:
            return json.loads(res.read() or b"{}")
    except urllib.error.HTTPError as exc:
        try:
            detail = json.loads(exc.read()).get("detail")
        except Exception:
            detail = None
        raise SendError(f"HTTP {exc.code}: {detail or exc.reason}", exc.code) from exc
    except (urllib.error.URLError, OSError, ValueError) as exc:
        raise SendError(f"Brak połączenia z {cfg['NETPULSE_URL']}: {exc}") from exc


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="netpulse-agent", description="NetPulse Agent – metryki serwera Linux")
    parser.add_argument("--config", default=CONFIG_PATH)
    parser.add_argument("--once", action="store_true", help="wyślij jeden raport i zakończ (test połączenia)")
    parser.add_argument("--print", action="store_true", help="pokaż raport zamiast wysyłać")
    parser.add_argument("--version", action="version", version=f"netpulse-agent {VERSION}")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", stream=sys.stdout)

    cfg = load_config(args.config)
    if not args.print and not (cfg["NETPULSE_URL"] and cfg["NETPULSE_TOKEN"]):
        log.error("Brak NETPULSE_URL albo NETPULSE_TOKEN w %s", args.config)
        return 2
    collector = Collector(cfg)
    time.sleep(1)  # pierwszy pomiar CPU potrzebuje dwóch odczytów
    if args.print:
        print(json.dumps(collector.collect(), indent=2, ensure_ascii=False))
        return 0
    if args.once:
        try:
            ack = send(cfg, collector.collect())
        except SendError as exc:
            log.error("%s", exc)
            return 1
        log.info("Raport przyjęty przez NetPulse %s%s", ack.get("server_version", "?"),
                 "" if ack.get("accepted", True) else " (serwer wyłączony w panelu – dane nie są zapisywane)")
        return 0

    interval = DEFAULT_INTERVAL
    log.info("NetPulse Agent %s → %s", VERSION, cfg["NETPULSE_URL"])
    while True:
        started = time.monotonic()
        try:
            ack = send(cfg, collector.collect())
            interval = max(10, int(ack.get("interval_s") or interval))
        except SendError as exc:
            if exc.status == 429:  # tuż po instalacji (raport testowy) – następny cykl przejdzie
                log.debug("%s", exc)
                time.sleep(interval)
                continue
            log.warning("%s", exc)
            if exc.status == 401:
                # Token odwołany albo serwer usunięty z panelu – nie męczymy API co 30 s
                log.error("Token odrzucony. Nowy token: NetPulse → Ustawienia → Agenci, potem ponowna instalacja.")
                time.sleep(300)
                continue
        except Exception:
            log.exception("Błąd zbierania danych")
        time.sleep(max(1.0, interval - (time.monotonic() - started)))


if __name__ == "__main__":
    sys.exit(main())
