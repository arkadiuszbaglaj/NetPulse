"""Driver MikroTik RouterOS (routery, switche CRS, access pointy).

Na bazie drivera generycznego (IF-MIB). RouterOS nie wystawia UCD-SNMP-MIB, więc CPU i pamięć czytamy
z HOST-RESOURCES-MIB (`hrProcessorLoad`, `hrStorage`), a nazwę płyty i wersję RouterOS z MIKROTIK-MIB.
Kind urządzenia wynika z nazwy płyty (CRS/CSS = switch, cAP/wAP/SXT = access point, reszta = router).

Interfejsy: `ether1` bez komentarza w RouterOS jest domyślnie WAN, a komentarz (ifAlias) ze słowem „wan”
albo „internet” oznacza WAN na dowolnym porcie – tak samo nazwa portu (porty bywają przemianowane, np. „WAN”, „LAN”;
przemianowany port Ethernet bez „wan” w nazwie to LAN). Tunele PPPoE nie są liczone jako WAN, bo ten sam ruch
przechodzi przez fizyczny port (suma po interfejsach WAN liczyłaby go podwójnie).

Czujniki, PoE i SFP (od 0.50.0) według oficjalnego MIKROTIK-MIB (RouterOS 7.25.1) trafiają do ogólnej tabeli `metrics`:
tabela `mtxrGaugeTable` (starsze płyty: pojedyncze wartości `mtxrHealth`), `mtxrPOETable`, `mtxrOpticalTable`."""

from __future__ import annotations

import logging
import re

from ..snmp import SnmpClient, SnmpError, as_int, as_str
from ..snmp import oids as O
from .base import DeviceHealth, InterfaceSample, MetricSample, PollResult, SystemInfo
from .generic import GenericDriver

_SWITCH_PREFIXES = ("CRS", "CSS", "RB260", "RB250")
_AP_PREFIXES = ("CAP", "WAP", "MAP", "SXT", "LHG", "NETMETAL", "BASEBOX", "DISC", "QRT", "LDF", "NETBOX")
_VIRTUAL = re.compile(r"^(bridge.*|vlan.*|pppoe-.*|l2tp-.*|pptp-.*|sstp-.*|ovpn-.*|wireguard.*|gre.*|eoip.*|vrrp.*|veth.*|lo)$")
_RADIO = re.compile(r"^(wlan\d+|wifi\d+|cap\d+)$")
_WAN_COMMENT = re.compile(r"\b(wan|internet)\b", re.IGNORECASE)
# Port przemianowany w RouterOS na „WAN”, „wan1”, „ether1-wan”, „Internet-LTE” (litery obok nie mogą tworzyć innego słowa)
_WAN_NAME = re.compile(r"(?:^|[^a-z])(wan|internet)(?:\d+|[^a-z]|$)", re.IGNORECASE)
_ETHER = re.compile(r"^(ether|sfp|sfp-sfpplus|qsfp\d*-?)(\d+)")

log = logging.getLogger("netpulse.drivers.mikrotik")

# mtxrGaugeUnit → (metryka w `metrics`, dzielnik): °C, rpm, dV, dA, dW, stan (np. zasilacz)
GAUGE_UNITS = {1: ("temp_c", 1), 2: ("fan_rpm", 1), 3: ("voltage_v", 10), 4: ("current_a", 10), 5: ("power_w", 10), 6: ("sensor_state", 1)}
# Starsze pojedyncze wartości mtxrHealth (gdy brak tabeli czujników): indeks → (metryka, klucz, dzielnik).
# Zera pomijamy – RouterOS zwraca 0 dla czujników, których płyta nie ma (np. CHR).
HEALTH_SCALARS = {
    1: ("voltage_v", "core-voltage", 10),
    2: ("voltage_v", "3.3V", 10),
    3: ("voltage_v", "5V", 10),
    4: ("voltage_v", "12V", 10),
    5: ("temp_c", "sensor-temperature", 10),
    6: ("temp_c", "cpu-temperature", 10),
    7: ("temp_c", "board-temperature", 10),
    8: ("voltage_v", "voltage", 10),
    10: ("temp_c", "temperature", 10),
    11: ("temp_c", "processor-temperature", 10),
    12: ("power_w", "power", 10),
    13: ("current_a", "current", 1000),
    17: ("fan_rpm", "fan1-speed", 1),
    18: ("fan_rpm", "fan2-speed", 1),
}
HEALTH_STATES = {15: "psu1-state", 16: "psu2-state"}  # BoolValue: 1 = zasilacz sprawny


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
        result = await super().poll(client, system)
        result.metrics = await self.read_sensors(client)
        return result

    async def read_sensors(self, client: SnmpClient) -> list[MetricSample]:
        """Czujniki, PoE i SFP. Błąd odczytu którejś tabeli nie psuje reszty odczytu urządzenia."""
        out: list[MetricSample] = []
        for read in (self._gauges, self._poe, self._optical):
            try:
                out += await read(client)
            except SnmpError as exc:
                log.debug("MikroTik: pominięto %s: %s", read.__name__, exc)
        return out

    async def _gauges(self, client: SnmpClient) -> list[MetricSample]:
        names = await client.walk(O.MIKROTIK_GAUGE_NAME)
        if not names:
            return await self._health_scalars(client)
        values = await client.walk(O.MIKROTIK_GAUGE_VALUE)
        units = await client.walk(O.MIKROTIK_GAUGE_UNIT)
        out = []
        for idx, raw_name in names.items():
            name, value, unit = as_str(raw_name), as_int(values.get(idx)), as_int(units.get(idx))
            if not name or value is None or unit not in GAUGE_UNITS:
                continue
            metric, divisor = GAUGE_UNITS[unit]
            out.append(MetricSample(metric, name, value / divisor))
        return out

    async def _health_scalars(self, client: SnmpClient) -> list[MetricSample]:
        values = await client.walk(O.MIKROTIK_HEALTH)
        out = []
        for suffix, raw in values.items():
            idx = int(suffix.split(".")[0]) if suffix.endswith(".0") and suffix.count(".") == 1 else None
            value = as_int(raw)
            if idx is None or value is None:
                continue
            if idx in HEALTH_SCALARS and value != 0:
                metric, key, divisor = HEALTH_SCALARS[idx]
                out.append(MetricSample(metric, key, value / divisor))
            elif idx in HEALTH_STATES:
                out.append(MetricSample("sensor_state", HEALTH_STATES[idx], float(value)))
        return out

    async def _poe(self, client: SnmpClient) -> list[MetricSample]:
        names = await client.walk(O.MIKROTIK_POE_NAME)
        if not names:
            return []
        status = await client.walk(O.MIKROTIK_POE_STATUS)
        voltage = await client.walk(O.MIKROTIK_POE_VOLTAGE)
        power = await client.walk(O.MIKROTIK_POE_POWER)
        out = []
        for idx, raw_name in names.items():
            port = as_str(raw_name)
            if not port:
                continue
            for metric, column, divisor in (("poe_state", status, 1), ("poe_voltage_v", voltage, 10), ("poe_power_w", power, 10)):
                v = as_int(column.get(idx))
                if v is not None:
                    out.append(MetricSample(metric, port, v / divisor))
        return out

    async def _optical(self, client: SnmpClient) -> list[MetricSample]:
        names = await client.walk(O.MIKROTIK_OPT_NAME)
        if not names:
            return []
        present = await client.walk(O.MIKROTIK_OPT_PRESENT)
        columns = (
            ("sfp_rx_dbm", O.MIKROTIK_OPT_RX_POWER, 1000),
            ("sfp_tx_dbm", O.MIKROTIK_OPT_TX_POWER, 1000),
            ("sfp_temp_c", O.MIKROTIK_OPT_TEMP, 1),
            ("sfp_voltage_v", O.MIKROTIK_OPT_VOLTAGE, 1000),
            ("sfp_rx_loss", O.MIKROTIK_OPT_RX_LOSS, 1),
            ("sfp_tx_fault", O.MIKROTIK_OPT_TX_FAULT, 1),
        )
        data = {metric: (await client.walk(oid), divisor) for metric, oid, divisor in columns}
        out = []
        for idx, raw_name in names.items():
            port = as_str(raw_name)
            if not port or as_int(present.get(idx)) == 0:  # pusta klatka SFP
                continue
            for metric, (column, divisor) in data.items():
                v = as_int(column.get(idx))
                if v is not None:
                    out.append(MetricSample(metric, port, v / divisor))
        return out

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
