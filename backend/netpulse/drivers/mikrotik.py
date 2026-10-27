"""Driver MikroTik RouterOS (routery, switche CRS, access pointy).

Na bazie drivera generycznego (IF-MIB). RouterOS nie wystawia UCD-SNMP-MIB, więc CPU i pamięć czytamy
z HOST-RESOURCES-MIB (`hrProcessorLoad`, `hrStorage`), a nazwę płyty i wersję RouterOS z MIKROTIK-MIB.
Kind urządzenia wynika z nazwy płyty (CRS/CSS = switch, cAP/wAP/SXT = access point, reszta = router).

Interfejsy: `ether1` bez komentarza w RouterOS jest domyślnie WAN, a komentarz (ifAlias) ze słowem „wan”
albo „internet” oznacza WAN na dowolnym porcie – tak samo nazwa portu (porty bywają przemianowane, np. „WAN”, „LAN”;
przemianowany port Ethernet bez „wan” w nazwie to LAN). Tunele PPPoE nie są liczone jako WAN, bo ten sam ruch
przechodzi przez fizyczny port (suma po interfejsach WAN liczyłaby go podwójnie)."""

from __future__ import annotations

import re

from ..snmp import SnmpClient, as_int, as_str
from ..snmp import oids as O
from .base import DeviceHealth, InterfaceSample, PollResult, SystemInfo
from .generic import GenericDriver

_SWITCH_PREFIXES = ("CRS", "CSS", "RB260", "RB250")
_AP_PREFIXES = ("CAP", "WAP", "MAP", "SXT", "LHG", "NETMETAL", "BASEBOX", "DISC", "QRT", "LDF", "NETBOX")
_VIRTUAL = re.compile(r"^(bridge.*|vlan.*|pppoe-.*|l2tp-.*|pptp-.*|sstp-.*|ovpn-.*|wireguard.*|gre.*|eoip.*|vrrp.*|veth.*|lo)$")
_RADIO = re.compile(r"^(wlan\d+|wifi\d+|cap\d+)$")
_WAN_COMMENT = re.compile(r"\b(wan|internet)\b", re.IGNORECASE)
# Port przemianowany w RouterOS na „WAN”, „wan1”, „ether1-wan”, „Internet-LTE” (litery obok nie mogą tworzyć innego słowa)
_WAN_NAME = re.compile(r"(?:^|[^a-z])(wan|internet)(?:\d+|[^a-z]|$)", re.IGNORECASE)
_ETHER = re.compile(r"^(ether|sfp|sfp-sfpplus|qsfp\d*-?)(\d+)")


class MikrotikDriver(GenericDriver):
    name = "mikrotik"
    vendor = "MikroTik"

    @classmethod
    def match(cls, system: SystemInfo) -> int:
        if (system.object_id or "").startswith(O.MIKROTIK_ENTERPRISE):
            return 100
        return 90 if (system.descr or "").startswith("RouterOS") else 0

    async def poll(self, client: SnmpClient, system: SystemInfo | None = None) -> PollResult:
        from .generic import read_system

        system = system or await read_system(client)
        # Nazwa płyty i wersja RouterOS decydują o typie urządzenia, więc czytamy je przed interpretacją
        v = await client.get([O.MIKROTIK_BOARD_NAME, O.MIKROTIK_LIC_VERSION])
        board = as_str(v.get(O.MIKROTIK_BOARD_NAME))
        system.model = board or (system.descr or "").removeprefix("RouterOS").strip() or None
        system.firmware = as_str(v.get(O.MIKROTIK_LIC_VERSION))
        return await super().poll(client, system)

    async def read_health(self, client: SnmpClient) -> DeviceHealth:
        loads = [as_int(x) for x in (await client.walk(O.HR_PROCESSOR_LOAD)).values()]
        loads = [x for x in loads if x is not None]
        health = DeviceHealth(cpu_percent=round(sum(loads) / len(loads), 1) if loads else None)

        ram = await self._ram(client)
        if ram:
            health.mem_total_kb, health.mem_used_kb = ram
        return health

    async def _ram(self, client: SnmpClient) -> tuple[int, int] | None:
        types = await client.walk(O.HR_STORAGE_TYPE)
        ram_index = next((i for i, t in types.items() if (as_str(t) or "").lstrip(".") == O.HR_STORAGE_RAM), None)
        if ram_index is None:
            return None
        v = await client.get([f"{O.HR_STORAGE_UNITS}.{ram_index}", f"{O.HR_STORAGE_SIZE}.{ram_index}", f"{O.HR_STORAGE_USED}.{ram_index}"])
        unit = as_int(v.get(f"{O.HR_STORAGE_UNITS}.{ram_index}"))
        size = as_int(v.get(f"{O.HR_STORAGE_SIZE}.{ram_index}"))
        used = as_int(v.get(f"{O.HR_STORAGE_USED}.{ram_index}"))
        if not unit or not size or used is None:
            return None
        return size * unit // 1024, used * unit // 1024

    def enrich_system(self, result: PollResult) -> None:
        system = result.system
        system.vendor = self.vendor
        model = (system.model or "").upper()
        if model.startswith(_SWITCH_PREFIXES):
            system.kind = "switch"
        elif model.startswith(_AP_PREFIXES):
            system.kind = "ap"
        else:
            system.kind = "gateway"  # RB, hEX, hAP, CCR, CHR: routery (hAP ma też WiFi, ale to przede wszystkim router)

    def enrich_interface(self, iface: InterfaceSample, result: PollResult) -> None:
        name = iface.name
        comment = iface.alias if iface.alias and iface.alias != name else None
        iface.alias = comment  # komentarz równy nazwie nic nie wnosi

        if _RADIO.match(name):
            iface.role, iface.hidden, iface.label = "radio", True, name
            return
        if _VIRTUAL.match(name) or iface.if_type in (O.IF_TYPE_LOOPBACK, O.IF_TYPE_TUNNEL):
            iface.role, iface.hidden, iface.label = "virtual", True, name
            return

        iface.label = comment or name
        gateway = result.system.kind == "gateway"
        wan_comment = bool(comment and _WAN_COMMENT.search(comment))
        default_wan = gateway and name == "ether1" and not comment
        wan_name = gateway and bool(_WAN_NAME.search(name))
        if wan_comment or default_wan or wan_name:
            iface.role = "wan"
            if not comment and not wan_name:
                iface.label = "WAN"
        elif _ETHER.match(name) or iface.if_type == O.IF_TYPE_ETHERNET:
            iface.role = "lan" if gateway else "port"
        else:
            super().enrich_interface(iface, result)
