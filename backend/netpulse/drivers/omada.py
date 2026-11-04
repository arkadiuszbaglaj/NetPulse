"""Driver TP-Link (urządzenia Omada i JetStream: switche, access pointy EAP, bramy ER/DR/FR).

Na bazie drivera generycznego (IF-MIB). Rozpoznaje producenta po identyfikatorze przedsiębiorstwa TP-Link
albo opisie systemu, typ urządzenia po modelu (EAP = access point, ER/DR/FR = brama, reszta = switch).

- Switche: porty „Port N” z numeru na końcu nazwy (`gi1/0/12`, `gigabitEthernet 1/0/12`), LAG jako „LAG N”.
  Od 0.51.0 według oficjalnego MIB-u switchy L2 (TP-Link_L2 Switch_MIB, `L2-tplinkMibs.zip` z 2024-02-29):
  CPU i RAM (`tplinkSysMonitorMIB`), wersja firmware (`tplinkSysInfoMIB`), PoE na portach
  (`tplinkPowerOverEthernetMIB`) i moduły SFP (`ddmStatus`, wartości jako tekst) – do tabeli `metrics`.
- Bramy: według oficjalnego FAQ Omada („How to Monitor Omada Gateway Link Status… Using SNMP”) mają tylko IF-MIB,
  łącza WAN to podinterfejsy VLAN `eth0.<VLAN>` (np. `eth0.10` = WAN1, `eth0.20` = WAN2), LAN = `br-lan`,
  reszta to interfejsy wewnętrzne.

Dane z kontrolera Omada (klienci z sygnałem, PoE z bram i EAP, stan WAN) to osobny etap (Open API)."""

from __future__ import annotations

import logging
import math
import re

from ..snmp import SnmpClient, SnmpError, as_int, as_str
from ..snmp import oids as O
from .base import DeviceHealth, InterfaceSample, MetricSample, PollResult, SystemInfo
from .generic import GenericDriver

log = logging.getLogger("netpulse.drivers.omada")

_MODEL = re.compile(r"\b((?:TL-)?(?:SG|SX|SL|TL-SG|EAP|ER|DR|FR|OC|SR)\d{2,4}[A-Z0-9\-]*)\b", re.IGNORECASE)
_GATEWAY_MODEL = re.compile(r"^(?:TL-)?(?:ER|DR|FR)\d{3,4}", re.IGNORECASE)
_TRAILING_NUMBER = re.compile(r"(\d+)\s*$")
_TECHNICAL = re.compile(r"^(vlan\s?\d+|loopback\d*|lo\d*|null\d*|cpu|mgmt\d*)$", re.IGNORECASE)
_LAG = re.compile(r"^(lag|port-channel|po)\s?(\d+)$", re.IGNORECASE)
_RADIO = re.compile(r"^(ra|rai|wlan|wifi|ath)\d*$", re.IGNORECASE)
# Bramy Omada
_GW_WAN = re.compile(r"^eth\d+\.(\d+)$")
_GW_LAN = re.compile(r"^br-lan")
_GW_INTERNAL = re.compile(
    r"^(eth\d+|lo|ifb\d*|imq\d*|teql\d*|dummy\d*|sit\d*|gre\d*|gretap\d*|erspan\d*|ip6tnl\d*|ip6gre\d*|ip_vti\d*|ip6_vti\d*|"
    r"tunl\d*|bond\d*|br-.*|pppoe.*|ppp\d*|l2tp.*|pptp.*|ipsec.*|wg\d*|tun\d*|tap\d*|veth.*|docker\d*)$",
    re.IGNORECASE,
)
_NUMBER = re.compile(r"-?\d+(?:\.\d+)?")
_FLAG_ON = re.compile(r"\b(yes|true|loss|fault|abnormal|alarm|on)\b", re.IGNORECASE)
_FLAG_OFF = re.compile(r"\b(no|false|normal|ok|off|none)\b", re.IGNORECASE)


def ddm_number(raw: object, power: bool = False) -> float | None:
    """Wartość DDM switcha TP-Link (DisplayString, np. „35.5”, „-3.25”, „0.5012 mW”) jako liczba; „--” = brak modułu."""
    text = as_str(raw) if raw is not None else None
    m = _NUMBER.search(text or "")
    if not m:
        return None
    value = float(m.group())
    if power and "mw" in (text or "").lower():  # moc w mW → dBm
        return round(10 * math.log10(value), 2) if value > 0 else None
    return value


def ddm_flag(raw: object) -> float | None:
    """Utrata sygnału / błąd nadajnika SFP: liczba albo słowo („Normal”, „Loss”, „Yes”…) → 0 albo 1."""
    text = as_str(raw) if raw is not None else None
    if not text:
        return None
    m = _NUMBER.fullmatch(text.strip())
    if m:
        return 1.0 if float(m.group()) >= 1 else 0.0
    if _FLAG_ON.search(text):
        return 1.0
    if _FLAG_OFF.search(text):
        return 0.0
    return None


class OmadaDriver(GenericDriver):
    name = "omada"
    vendor = "TP-Link"

    @classmethod
    def match(cls, system: SystemInfo) -> int:
        if (system.object_id or "").startswith(O.TPLINK_ENTERPRISE):
            return 100
        descr = (system.descr or "").lower()
        return 80 if "tp-link" in descr or "omada" in descr or "jetstream" in descr else 0

    async def poll(self, client: SnmpClient, system: SystemInfo | None = None) -> PollResult:
        result = await super().poll(client, system)
        if result.system.kind == "ap":
            return result
        try:
            v = await client.get([O.TPLINK_SW_VERSION])
            result.system.firmware = as_str(v.get(O.TPLINK_SW_VERSION)) or result.system.firmware
        except SnmpError as exc:
            log.debug("TP-Link: brak wersji firmware: %s", exc)
        result.metrics = await self.read_sensors(client, result)
        return result

    # --- odczyt: CPU/RAM, PoE, SFP (switche) ---------------------------------------

    async def read_health(self, client: SnmpClient) -> DeviceHealth:
        try:
            cpu = [x for x in (as_int(v) for v in (await client.walk(O.TPLINK_CPU_1MIN)).values()) if x is not None]
            mem = [x for x in (as_int(v) for v in (await client.walk(O.TPLINK_MEM_UTIL)).values()) if x is not None]
        except SnmpError as exc:
            log.debug("TP-Link: brak tplinkSysMonitorMIB: %s", exc)
            cpu, mem = [], []
        if not cpu and not mem:
            return await super().read_health(client)  # brama albo EAP: może mieć UCD-SNMP-MIB
        return DeviceHealth(
            cpu_percent=round(sum(cpu) / len(cpu), 1) if cpu else None,
            mem_percent=round(sum(mem) / len(mem), 1) if mem else None,
        )

    async def read_sensors(self, client: SnmpClient, result: PollResult) -> list[MetricSample]:
        """PoE i SFP. Błąd odczytu którejś tabeli nie psuje reszty odczytu urządzenia."""
        out: list[MetricSample] = []
        for read in (self._poe, self._ddm):
            try:
                out += await read(client, result)
            except SnmpError as exc:
                log.debug("TP-Link: pominięto %s: %s", read.__name__, exc)
        return out

    @staticmethod
    def _port_by_number(result: PollResult) -> dict[int, str]:
        """Numer portu → nazwa interfejsu (pierwsza jednostka stosu wygrywa)."""
        ports: dict[int, str] = {}
        for iface in sorted(result.interfaces, key=lambda i: i.if_index):
            m = _TRAILING_NUMBER.search(iface.name)
            if iface.role == "port" and m:
                ports.setdefault(int(m.group(1)), iface.name)
        return ports

    async def _poe(self, client: SnmpClient, result: PollResult) -> list[MetricSample]:
        power = await client.walk(O.TPLINK_POE_POWER)
        if not power:
            return []
        voltage = await client.walk(O.TPLINK_POE_VOLTAGE)
        status = await client.walk(O.TPLINK_POE_STATUS)
        ports = self._port_by_number(result)
        out = []
        for idx in power:
            number = as_int(idx.split(".")[-1])
            if number is None:
                continue
            port = ports.get(number, f"Port {number}")
            raw_state = as_int(status.get(idx))
            # MIB: 0 wył., 1 włączanie, 2 zasila, 3 przeciążenie, 4 zwarcie, 5 niestandardowe PD, 6/7 napięcie, 8 błąd, 9 temp.
            # Panel (wspólny z MikroTikiem): 1 wył., 2 czeka, 3 zasila, 4 przeciążenie, 5 zwarcie, >5 = błąd
            state = None if raw_state is None else float(raw_state + 1)
            for metric, value in (
                ("poe_power_w", as_int(power.get(idx))),
                ("poe_voltage_v", as_int(voltage.get(idx))),
            ):
                if value is not None:
                    out.append(MetricSample(metric, port, value / 10))
            if state is not None:
                out.append(MetricSample("poe_state", port, state))
        return out

    async def _ddm(self, client: SnmpClient, result: PollResult) -> list[MetricSample]:
        names = await client.walk(O.TPLINK_DDM_PORT)
        if not names:
            return []
        columns = {
            "sfp_temp_c": (O.TPLINK_DDM_TEMP, False),
            "sfp_voltage_v": (O.TPLINK_DDM_VOLTAGE, False),
            "sfp_tx_dbm": (O.TPLINK_DDM_TX_POWER, True),
            "sfp_rx_dbm": (O.TPLINK_DDM_RX_POWER, True),
        }
        data = {metric: (await client.walk(oid), power) for metric, (oid, power) in columns.items()}
        loss = await client.walk(O.TPLINK_DDM_RX_LOSS)
        fault = await client.walk(O.TPLINK_DDM_TX_FAULT)
        by_number = self._port_by_number(result)
        out = []
        for idx, raw_name in names.items():
            port = self._ddm_port(as_str(raw_name) or "", result, by_number)
            if not port:
                continue
            values = {metric: ddm_number(column.get(idx), power) for metric, (column, power) in data.items()}
            if all(v is None for v in values.values()):  # pusta klatka SFP
                continue
            values["sfp_rx_loss"] = ddm_flag(loss.get(idx))
            values["sfp_tx_fault"] = ddm_flag(fault.get(idx))
            out += [MetricSample(metric, port, v) for metric, v in values.items() if v is not None]
        return out

    @staticmethod
    def _ddm_port(text: str, result: PollResult, by_number: dict[int, str]) -> str | None:
        """„1/0/25” albo „Port 25” z tabeli DDM → nazwa interfejsu (`Te1/0/25`), żeby panel złączył SFP z portem."""
        text = text.strip()
        if not text:
            return None
        for iface in result.interfaces:
            if iface.name.lower().endswith(text.lower()) and not iface.name[: -len(text)][-1:].isdigit():
                return iface.name
        m = _TRAILING_NUMBER.search(text)
        return by_number.get(int(m.group(1)), text) if m else text

    # --- interpretacja ----------------------------------------------------------

    def enrich_system(self, result: PollResult) -> None:
        system = result.system
        system.vendor = self.vendor
        descr = system.descr or ""
        m = _MODEL.search(descr) or _MODEL.search(system.name or "")
        system.model = (m.group(1).upper() if m else descr.strip())[:64] or None
        upper = f"{system.model or ''} {descr}".upper()
        if "EAP" in upper or "ACCESS POINT" in upper:
            system.kind = "ap"
        elif _GATEWAY_MODEL.match(system.model or "") or "ROUTER" in upper or "GATEWAY" in upper:
            system.kind = "gateway"
        else:
            system.kind = "switch"

    def enrich_interface(self, iface: InterfaceSample, result: PollResult) -> None:
        name = iface.name.strip()
        if iface.alias and iface.alias in (iface.name, iface.descr):
            iface.alias = None

        if result.system.kind == "gateway":
            self._gateway_interface(iface, name, result)
            return
        if _TECHNICAL.match(name) or iface.if_type == O.IF_TYPE_LOOPBACK:
            iface.role, iface.hidden, iface.label = "system", True, name
            return
        if _RADIO.match(name):
            iface.role, iface.hidden, iface.label = "radio", True, name
            return
        lag = _LAG.match(name)
        if lag:
            iface.role, iface.label = "lag", f"LAG {lag.group(2)}"
            return

        m = _TRAILING_NUMBER.search(name)
        if m and result.system.kind == "switch":
            iface.role, iface.label = "port", f"Port {m.group(1)}"
        elif m and result.system.kind == "ap" and name.lower().startswith("eth"):
            iface.role, iface.label = "uplink", "Uplink"
        else:
            super().enrich_interface(iface, result)

    @staticmethod
    def _gateway_interface(iface: InterfaceSample, name: str, result: PollResult) -> None:
        wan = _GW_WAN.match(name)
        if wan:
            # Kolejność łączy według numeru VLAN (WAN1 = VLAN 10, WAN2 = VLAN 20 w domyślnej konfiguracji)
            vlans = sorted(int(m.group(1)) for i in result.interfaces if (m := _GW_WAN.match(i.name.strip())))
            iface.role = "wan"
            iface.label = iface.alias or ("WAN" if len(vlans) == 1 else f"WAN {vlans.index(int(wan.group(1))) + 1}")
        elif _GW_LAN.match(name):
            iface.role, iface.label = "lan", iface.alias or "LAN"
        elif _GW_INTERNAL.match(name) or iface.if_type in (O.IF_TYPE_LOOPBACK, O.IF_TYPE_TUNNEL):
            iface.role, iface.hidden, iface.label = "system", True, name
        else:
            iface.label = iface.alias or name
