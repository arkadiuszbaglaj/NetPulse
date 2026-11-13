"""Urządzenia UniFi bez SNMP (np. USW Flex, USW Ultra) z oficjalnego Network API – od 0.52.0.

Kolektor UniFi zakłada dla nich urządzenie UplinkView z `driver = "unifi_api"` i co cykl buduje `PollResult`
taki jak z drivera SNMP, więc zapis, wykresy, alerty i karta urządzenia działają bez zmian:

- oficjalne API (`/integration/v1`): model, firmware, stan, uptime, CPU, RAM, load, porty (stan, prędkość),
- starsze `stat/device` (ten sam klucz): liczniki ruchu, błędy i nazwy portów – oficjalne API ich nie podaje.

Nazwy portów switcha to `0/N`, jak `ifName` switchy UniFi w SNMP – dzięki temu moc PoE z kontrolera trafia
do właściwego portu w panelu.
"""

from __future__ import annotations

from .drivers.base import DeviceHealth, InterfaceSample, PollResult, SystemInfo
from .unifi import GATEWAY_TYPES, OfficialDevice, UnifiDevice

DRIVER = "unifi_api"
_STATE = {"UP": "up", "DOWN": "down"}
# Bramy, które oficjalne API opisuje tylko jako `switching` (np. UCG Ultra) – rozpoznanie po modelu
_GATEWAY_MODELS = ("UCG", "UDM", "UDR", "UXG", "USG", "UGW", "UDW", "UX")


def device_kind(device: OfficialDevice, legacy: UnifiDevice | None = None) -> str:
    """Rodzaj urządzenia: typ ze starszego API (udm/usw/uap) ma pierwszeństwo, potem model i `features`."""
    if legacy is not None:
        if legacy.type in GATEWAY_TYPES:
            return "gateway"
        if legacy.type == "usw":
            return "switch"
        if legacy.type == "uap":
            return "ap"
    model = (device.model or "").upper()
    if model.startswith(_GATEWAY_MODELS):
        return "gateway"
    return device.kind


def port_name(kind: str, idx: int) -> str:
    """Nazwa portu: switch `0/N` (jak ifName w SNMP), brama `ethN-1` (jak UCG/UDM), AP `ethN-1`."""
    return f"0/{idx}" if kind == "switch" else f"eth{idx - 1}"


def build_poll_result(device: OfficialDevice, legacy: UnifiDevice | None = None) -> PollResult:
    kind = device_kind(device, legacy)
    stats = {p.port_idx: p for p in (legacy.ports if legacy else ())}
    wan_names = {w.ifname for w in (legacy.wans if legacy else ())}
    interfaces: list[InterfaceSample] = []
    for p in device.ports:
        s = stats.get(p.idx)
        name = port_name(kind, p.idx)
        default_label = f"Port {p.idx}"
        alias = s.name if s and s.name and s.name != default_label else None
        iface = InterfaceSample(
            if_index=p.idx,
            name=name,
            descr=f"{p.connector or 'Port'} {p.idx}",
            alias=alias,
            if_type=6,
            admin_up=None,
            oper_status=_STATE.get(p.state, "unknown"),
            speed_mbps=p.speed_mbps if p.state == "UP" else None,
            in_octets=s.rx_bytes if s else None,
            out_octets=s.tx_bytes if s else None,
            counter_bits=64,
            in_errors=s.rx_errors if s else None,
            out_errors=s.tx_errors if s else None,
            in_discards=s.rx_dropped if s else None,
            out_discards=s.tx_dropped if s else None,
            label=alias or default_label,
        )
        if kind == "gateway" and name in wan_names:
            iface.role, iface.label = "wan", alias or "WAN"
        elif kind == "gateway":
            iface.role = "lan"
        elif kind == "ap":
            iface.role, iface.label = "uplink", alias or "Uplink"
        interfaces.append(iface)
    system = SystemInfo(
        name=device.name,
        descr=f"UniFi {device.model or ''} (oficjalne API)".replace("  ", " "),
        uptime_s=float(device.uptime_s) if device.uptime_s is not None else None,
        vendor="Ubiquiti",
        model=(device.model or "")[:64] or None,
        firmware=device.firmware,
        kind=kind,
    )
    health = DeviceHealth(
        cpu_percent=device.cpu_percent,
        mem_percent=device.mem_percent,
        load1=device.load1,
        load5=device.load5,
        load15=device.load15,
    )
    return PollResult(driver=DRIVER, system=system, interfaces=interfaces, health=health)
