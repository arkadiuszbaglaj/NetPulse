#!/usr/bin/env python3
"""Zrzut `unifi_probe.py` → małe fixtures testowe (stat/device i stat/sta).

Zostawia tylko pola, których używa NetPulse; resztę (klucze, adresy adopcji, odciski SSH itp.) odrzuca.

Użycie:
    python probe2fixtures.py unifi_probe_192.168.1.1.json tests/fixtures
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

DEVICE_KEYS = (
    "type", "model", "name", "mac", "ip", "state", "version", "num_sta", "uptime",
    "total_used_power", "total_max_power", "overheating", "port_table", "lldp_table",
)  # fmt: skip
PORT_KEYS = (
    "port_idx", "name", "up", "enable", "speed", "full_duplex", "is_uplink", "port_poe", "poe_caps", "poe_mode",
    "poe_enable", "poe_good", "poe_class", "poe_power", "poe_voltage", "poe_current", "rx_bytes", "tx_bytes",
    "rx_bytes-r", "tx_bytes-r", "rx_errors", "tx_errors", "rx_dropped", "tx_dropped",
)  # fmt: skip
LLDP_KEYS = ("chassis_id", "local_port_idx", "local_port_name", "port_id")
STA_KEYS = (
    "mac", "name", "hostname", "ip", "is_wired", "is_guest", "essid", "radio", "channel", "signal", "rssi", "noise",
    "tx_rate", "rx_rate", "ap_mac", "sw_mac", "sw_port", "last_uplink_name", "last_uplink_mac", "uptime", "last_seen",
    "satisfaction", "network", "tx_bytes", "rx_bytes", "tx_bytes-r", "rx_bytes-r",
)  # fmt: skip


def pick(obj: dict, keys: tuple[str, ...]) -> dict:
    return {k: obj[k] for k in keys if k in obj}


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    probe = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    out = Path(sys.argv[2])
    by_suffix = {path.rsplit("/", 1)[-1]: res["json"] for path, res in probe.items() if "/api/s/default/" in path and "json" in res}

    devices = []
    for d in by_suffix["device"]["data"]:
        item = pick(d, DEVICE_KEYS)
        item["port_table"] = [pick(p, PORT_KEYS) for p in d.get("port_table", [])]
        if "lldp_table" in d:
            item["lldp_table"] = [pick(x, LLDP_KEYS) for x in d["lldp_table"]]
        devices.append(item)
    clients = [pick(s, STA_KEYS) for s in by_suffix["sta"]["data"]]

    meta = {"meta": {"rc": "ok"}}
    (out / "unifi_devices.json").write_text(json.dumps({**meta, "data": devices}, ensure_ascii=False, indent=1), encoding="utf-8")
    (out / "unifi_clients.json").write_text(json.dumps({**meta, "data": clients}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{len(devices)} urzadzen, {len(clients)} klientow -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
