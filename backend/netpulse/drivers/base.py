"""Wspólne struktury danych i bazowa klasa drivera."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import ClassVar

from ..snmp import SnmpClient

OPER_STATUS = {
    1: "up",
    2: "down",
    3: "testing",
    4: "unknown",
    5: "dormant",
    6: "notPresent",
    7: "lowerLayerDown",
}


@dataclass
class SystemInfo:
    name: str | None = None
    descr: str | None = None
    object_id: str | None = None
    uptime_s: float | None = None
    contact: str | None = None
    location: str | None = None
    # Uzupełniane przez driver
    vendor: str | None = None
    model: str | None = None
    firmware: str | None = None
    kind: str = "other"  # gateway | switch | ap | server | other


@dataclass
class InterfaceSample:
    if_index: int
    name: str
    descr: str | None = None
    alias: str | None = None
    if_type: int | None = None
    mac: str | None = None
    admin_up: bool | None = None
    oper_status: str = "unknown"
    speed_mbps: int | None = None
    in_octets: int | None = None
    out_octets: int | None = None
    counter_bits: int = 64
    in_errors: int | None = None
    out_errors: int | None = None
    in_discards: int | None = None
    out_discards: int | None = None
    # Uzupełniane przez driver
    label: str = ""
    role: str = "port"  # wan | lan | port | uplink | radio | virtual | system
    hidden: bool = False


@dataclass
class DeviceHealth:
    cpu_percent: float | None = None
    mem_total_kb: int | None = None
    mem_used_kb: int | None = None
    load1: float | None = None
    load5: float | None = None
    load15: float | None = None

    @property
    def mem_used_percent(self) -> float | None:
        if self.mem_total_kb and self.mem_used_kb is not None:
            return round(100.0 * self.mem_used_kb / self.mem_total_kb, 1)
        return None


@dataclass
class WifiSample:
    key: str  # nazwa interfejsu VAP, np. "rai2"
    ssid: str
    radio: str | None = None  # "2.4GHz" | "5GHz" | "6GHz"
    channel: int | None = None
    bssid: str | None = None
    clients: int | None = None
    rx_octets: int | None = None
    tx_octets: int | None = None
    counter_bits: int = 32
    hidden: bool = False


@dataclass
class DiskSample:
    """Partycja serwera (HOST-RESOURCES-MIB hrStorage), rozmiary w bajtach."""

    mount: str
    total_bytes: int
    used_bytes: int

    @property
    def used_percent(self) -> float:
        return round(100.0 * self.used_bytes / self.total_bytes, 1) if self.total_bytes else 0.0


@dataclass
class ServerSample:
    swap_used_percent: float | None = None
    processes: int | None = None


@dataclass
class PollResult:
    driver: str
    system: SystemInfo
    interfaces: list[InterfaceSample] = field(default_factory=list)
    health: DeviceHealth = field(default_factory=DeviceHealth)
    wifi: list[WifiSample] = field(default_factory=list)
    disks: list[DiskSample] = field(default_factory=list)
    server: ServerSample | None = None

    def visible_interfaces(self) -> list[InterfaceSample]:
        return [i for i in self.interfaces if not i.hidden]


class Driver:
    """Bazowy driver. Podklasy nadpisują `match` i metody `enrich_*`."""

    name: ClassVar[str] = "base"
    vendor: ClassVar[str] = "Generic"

    @classmethod
    def match(cls, system: SystemInfo) -> int:
        """Jak dobrze driver pasuje do urządzenia (0 = wcale, 100 = idealnie)."""
        return 0

    async def poll(self, client: SnmpClient) -> PollResult:  # pragma: no cover - abstrakcja
        raise NotImplementedError
