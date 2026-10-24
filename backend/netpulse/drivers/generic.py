"""Driver generyczny: SNMPv2-MIB, IF-MIB, UCD-SNMP-MIB.

Działa z każdym urządzeniem obsługującym standardowe MIB-y. Drivery producentów
dziedziczą po nim i nadpisują `enrich_*`.
"""

from __future__ import annotations

from ..snmp import SnmpClient, as_float, as_int, as_mac, as_str
from ..snmp import oids as O
from .base import (
    OPER_STATUS,
    DeviceHealth,
    Driver,
    InterfaceSample,
    PollResult,
    SystemInfo,
    WifiSample,
)

_SYSTEM_OIDS = [O.SYS_DESCR, O.SYS_OBJECT_ID, O.SYS_UPTIME, O.SYS_CONTACT, O.SYS_NAME, O.SYS_LOCATION]
_HEALTH_OIDS = [
    O.UCD_MEM_TOTAL_REAL,
    O.UCD_MEM_AVAIL_REAL,
    O.UCD_MEM_BUFFER,
    O.UCD_MEM_CACHED,
    O.UCD_LOAD_1,
    O.UCD_LOAD_5,
    O.UCD_LOAD_15,
    O.UCD_CPU_IDLE,
]


async def read_system(client: SnmpClient) -> SystemInfo:
    v = await client.get(_SYSTEM_OIDS)
    uptime = as_int(v.get(O.SYS_UPTIME))
    object_id = as_str(v.get(O.SYS_OBJECT_ID))
    return SystemInfo(
        name=as_str(v.get(O.SYS_NAME)),
        descr=as_str(v.get(O.SYS_DESCR)),
        object_id=object_id.lstrip(".") if object_id else None,
        uptime_s=uptime / 100.0 if uptime is not None else None,
        contact=as_str(v.get(O.SYS_CONTACT)),
        location=as_str(v.get(O.SYS_LOCATION)),
    )


class GenericDriver(Driver):
    name = "generic"
    vendor = "Generic"

    @classmethod
    def match(cls, system: SystemInfo) -> int:
        return 1  # zawsze jako ostatnia deska ratunku

    async def poll(self, client: SnmpClient, system: SystemInfo | None = None) -> PollResult:
        if system is None:
            system = await read_system(client)
        system.vendor = system.vendor or self.vendor
        interfaces = await self.read_interfaces(client)
        health = await self.read_health(client)
        wifi = await self.read_wifi(client)
        result = PollResult(
            driver=self.name, system=system, interfaces=interfaces, health=health, wifi=wifi
        )
        self.enrich_system(result)
        for iface in result.interfaces:
            self.enrich_interface(iface, result)
        return result

    # --- odczyt ---------------------------------------------------------------

    async def read_interfaces(self, client: SnmpClient) -> list[InterfaceSample]:
        cols = {}
        for key, oid in (
            ("descr", O.IF_DESCR),
            ("type", O.IF_TYPE),
            ("speed", O.IF_SPEED),
            ("mac", O.IF_PHYS_ADDRESS),
            ("admin", O.IF_ADMIN_STATUS),
            ("oper", O.IF_OPER_STATUS),
            ("in32", O.IF_IN_OCTETS),
            ("out32", O.IF_OUT_OCTETS),
            ("in_disc", O.IF_IN_DISCARDS),
            ("in_err", O.IF_IN_ERRORS),
            ("out_disc", O.IF_OUT_DISCARDS),
            ("out_err", O.IF_OUT_ERRORS),
            ("name", O.IF_NAME),
            ("in64", O.IF_HC_IN_OCTETS),
            ("out64", O.IF_HC_OUT_OCTETS),
            ("high_speed", O.IF_HIGH_SPEED),
            ("alias", O.IF_ALIAS),
        ):
            cols[key] = await client.walk(oid)

        indexes = sorted(
            {int(i) for i in cols["descr"]} | {int(i) for i in cols["name"]}
        )
        result: list[InterfaceSample] = []
        for idx in indexes:
            k = str(idx)
            name = as_str(cols["name"].get(k)) or as_str(cols["descr"].get(k)) or f"if{idx}"
            high = as_int(cols["high_speed"].get(k))
            speed = high if high else None
            if speed is None:
                raw = as_int(cols["speed"].get(k))
                speed = raw // 1_000_000 if raw else None
            if k in cols["in64"] and k in cols["out64"]:
                in_oct, out_oct, bits = as_int(cols["in64"][k]), as_int(cols["out64"][k]), 64
            else:
                in_oct, out_oct, bits = as_int(cols["in32"].get(k)), as_int(cols["out32"].get(k)), 32
            admin = as_int(cols["admin"].get(k))
            result.append(
                InterfaceSample(
                    if_index=idx,
                    name=name,
                    descr=as_str(cols["descr"].get(k)),
                    alias=as_str(cols["alias"].get(k)) or None,
                    if_type=as_int(cols["type"].get(k)),
                    mac=as_mac(cols["mac"].get(k)),
                    admin_up=None if admin is None else admin == 1,
                    oper_status=OPER_STATUS.get(as_int(cols["oper"].get(k)) or 4, "unknown"),
                    speed_mbps=speed,
                    in_octets=in_oct,
                    out_octets=out_oct,
                    counter_bits=bits,
                    in_errors=as_int(cols["in_err"].get(k)),
                    out_errors=as_int(cols["out_err"].get(k)),
                    in_discards=as_int(cols["in_disc"].get(k)),
                    out_discards=as_int(cols["out_disc"].get(k)),
                )
            )
        return result

    async def read_health(self, client: SnmpClient) -> DeviceHealth:
        v = await client.get(_HEALTH_OIDS)
        total = as_int(v.get(O.UCD_MEM_TOTAL_REAL))
        avail = as_int(v.get(O.UCD_MEM_AVAIL_REAL))
        used = None
        if total and avail is not None:
            buffers = as_int(v.get(O.UCD_MEM_BUFFER)) or 0
            cached = as_int(v.get(O.UCD_MEM_CACHED)) or 0
            used = max(total - avail - buffers - cached, 0)
        idle = as_int(v.get(O.UCD_CPU_IDLE))
        return DeviceHealth(
            cpu_percent=float(100 - idle) if idle is not None else None,
            mem_total_kb=total,
            mem_used_kb=used,
            load1=as_float(v.get(O.UCD_LOAD_1)),
            load5=as_float(v.get(O.UCD_LOAD_5)),
            load15=as_float(v.get(O.UCD_LOAD_15)),
        )

    async def read_wifi(self, client: SnmpClient) -> list[WifiSample]:
        return []

    # --- interpretacja ----------------------------------------------------------

    def enrich_system(self, result: PollResult) -> None:
        if result.system.model is None and result.system.descr:
            result.system.model = result.system.descr.split()[0][:64]

    def enrich_interface(self, iface: InterfaceSample, result: PollResult) -> None:
        if iface.if_type == O.IF_TYPE_LOOPBACK:
            iface.role, iface.hidden = "system", True
        if not iface.label:
            iface.label = iface.alias if iface.alias and iface.alias != iface.name else (
                iface.descr or iface.name
            )
