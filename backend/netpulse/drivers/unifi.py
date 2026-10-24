"""Driver Ubiquiti UniFi (gatewaye UCG/UDM, switche USW, access pointy U6/U7/UAP).

Rozszerza driver generyczny o:
- rozpoznanie modelu, firmware i typu urządzenia,
- nazwy i role portów (WAN/LAN na gatewayu, Port N na switchu, uplink na AP),
- ukrywanie interfejsów technicznych,
- sieci WiFi z UBNT-UniFi-MIB (SSID, kanał, liczba klientów, ruch).
"""

from __future__ import annotations

import re

from ..snmp import SnmpClient, as_int, as_mac, as_str
from ..snmp import oids as O
from .base import InterfaceSample, PollResult, SystemInfo, WifiSample
from .generic import GenericDriver

_TECHNICAL = re.compile(
    r"^(lo|dummy\d*|ip_vti\d*|ip6_vti\d*|ip6tnl\d*|ip6gre\d*|gre\d*|sit\d*|tunl\d*|miireg|"
    r"bond\d+|ifb\d+|teql\d*|imq\d*|erspan\d*|gretap\d*|ip6erspan\d*)$"
)
_VIRTUAL = re.compile(r"^(switch\d+(\.\d+)?|br\d+(\.\d+)?|br-.*|vlan\d+|eth\d+\.\d+|wg\d+|tun\d+|tap\d+)$")
_RADIO = re.compile(r"^(ra|rai|rax|wifi|ath|wlan|apcli|apclii)\d*$")
_SWITCH_PORT = re.compile(r"^0/(\d+)$")
_ETH = re.compile(r"^eth(\d+)$")

_GATEWAY_PREFIXES = ("UCG", "UDM", "UDR", "UXG", "USG", "UDW", "UX", "EFG")
_SWITCH_PREFIXES = ("USW", "US-", "USL", "USM", "USF", "USPM", "ECS")
_AP_PREFIXES = ("U6", "U7", "UAP", "UAL", "UAC", "UAE", "E7", "U5", "UWB", "UMA", "BZ2", "UBB")

# Mapowanie portów fizycznych gatewayi: ethN -> (rola, etykieta)
_GATEWAY_PORT_MAP: dict[str, dict[str, tuple[str, str]]] = {
    "UCG-Ultra": {
        "eth4": ("wan", "WAN"),
        "eth0": ("lan", "LAN 1"),
        "eth1": ("lan", "LAN 2"),
        "eth2": ("lan", "LAN 3"),
        "eth3": ("lan", "LAN 4"),
    },
}

_RADIO_BANDS = {"ng": "2.4GHz", "na": "5GHz", "6e": "6GHz", "ax6": "6GHz"}


class UnifiDriver(GenericDriver):
    name = "unifi"
    vendor = "Ubiquiti"

    @classmethod
    def match(cls, system: SystemInfo) -> int:
        if system.object_id and system.object_id.startswith(O.UBNT_ENTERPRISE):
            return 100
        descr = (system.descr or "").lower()
        if "unifi" in descr or "ubiquiti" in descr or "ubnt" in descr:
            return 90
        if (system.name or "").upper().startswith(("USW", "UCG", "UDM", "U6", "U7", "UAP")):
            return 60
        return 0

    async def read_wifi(self, client: SnmpClient) -> list[WifiSample]:
        essid = await client.walk(O.UNIFI_VAP_ESSID)
        if not essid:
            return []
        name = await client.walk(O.UNIFI_VAP_NAME)
        bssid = await client.walk(O.UNIFI_VAP_BSSID)
        channel = await client.walk(O.UNIFI_VAP_CHANNEL)
        stations = await client.walk(O.UNIFI_VAP_NUM_STATIONS)
        radio = await client.walk(O.UNIFI_VAP_RADIO)
        rx = await client.walk(O.UNIFI_VAP_RX_BYTES)
        tx = await client.walk(O.UNIFI_VAP_TX_BYTES)
        result = []
        for idx in sorted(essid, key=int):
            ssid = as_str(essid[idx]) or ""
            band = as_str(radio.get(idx))
            result.append(
                WifiSample(
                    key=as_str(name.get(idx)) or f"vap{idx}",
                    ssid=ssid,
                    radio=_RADIO_BANDS.get(band or "", band),
                    channel=as_int(channel.get(idx)),
                    bssid=as_mac(bssid.get(idx)),
                    clients=as_int(stations.get(idx)),
                    rx_octets=as_int(rx.get(idx)),
                    tx_octets=as_int(tx.get(idx)),
                    counter_bits=32,
                    hidden=ssid.startswith(("element-", "vwire-")) or not ssid,
                )
            )
        return result

    def enrich_system(self, result: PollResult) -> None:
        system = result.system
        descr = system.descr or ""
        m = re.search(r"UniFi\s+(\S+)\s+(\d[\w.\-]*)", descr)
        if m:
            system.model, system.firmware = m.group(1), m.group(2)
        else:
            m = re.match(r"^(U\S+)\s+(\d+\.\d+\.\d+[\w.\-]*)$", descr)
            if m:
                system.model, system.firmware = m.group(1), m.group(2)

        model = (system.model or system.name or "").upper()
        if model.startswith(_GATEWAY_PREFIXES):
            system.kind = "gateway"
        elif model.startswith(_SWITCH_PREFIXES):
            system.kind = "switch"
        elif model.startswith(_AP_PREFIXES) or result.wifi:
            system.kind = "ap"
        elif any(_SWITCH_PORT.match(i.name) for i in result.interfaces):
            system.kind = "switch"

        if system.model is None:
            system.model = {
                "switch": "UniFi Switch",
                "ap": "UniFi AP",
                "gateway": "UniFi Gateway",
            }.get(system.kind, "UniFi")

    def enrich_interface(self, iface: InterfaceSample, result: PollResult) -> None:
        kind = result.system.kind
        name = iface.name

        # Alias równy domyślnej nazwie nic nie wnosi
        if iface.alias and iface.alias in (iface.name, iface.descr):
            iface.alias = None

        if _TECHNICAL.match(name) or iface.if_type == O.IF_TYPE_LOOPBACK:
            iface.role, iface.hidden, iface.label = "system", True, name
            return
        if _RADIO.match(name):
            iface.role, iface.hidden, iface.label = "radio", True, name
            return
        if _VIRTUAL.match(name):
            iface.role, iface.hidden, iface.label = "virtual", True, name
            return

        m = _SWITCH_PORT.match(name)
        if m:
            iface.role = "port"
            iface.label = f"Port {m.group(1)}"
            return

        if kind == "gateway" and _ETH.match(name):
            port_map = _GATEWAY_PORT_MAP.get(result.system.model or "", {})
            if name in port_map:
                iface.role, iface.label = port_map[name]
            else:
                iface.role, iface.label = "port", f"Port {int(_ETH.match(name).group(1)) + 1}"
            return

        if kind == "ap" and _ETH.match(name):
            iface.role, iface.label = "uplink", "Uplink" if name == "eth0" else name
            return

        super().enrich_interface(iface, result)
