"""Driver serwerów Linux z `snmpd` (net-snmp): dyski, swap, procesy, interfejsy bez śmieci z Dockera.

Na bazie drivera generycznego (SNMPv2-MIB, IF-MIB, UCD-SNMP-MIB: CPU, RAM, obciążenie). Dochodzą:
- dyski i partycje z HOST-RESOURCES-MIB (`hrStorageTable`), bez pamięci, tmpfs, snap-ów i warstw Dockera,
- swap z UCD-SNMP-MIB, liczba procesów z HOST-RESOURCES-MIB,
- `kind = server`, model i wersja jądra z `sysDescr`,
- ukrycie interfejsów technicznych (`veth*`, `docker0`, mosty `br-*`, `virbr*`, `cali*`, `flannel*`).
"""

from __future__ import annotations

import re

from ..snmp import SnmpClient, as_int, as_str
from ..snmp import oids as O
from .base import DiskSample, InterfaceSample, PollResult, ServerSample, SystemInfo
from .generic import GenericDriver

# net-snmp na Linuksie: NET-SNMP-MIB::netSnmpAgentOIDs.10
_LINUX_AGENT = "1.3.6.1.4.1.8072.3.2.10"

_VIRTUAL_IF = re.compile(
    r"^(veth.*|docker\d*|br-[0-9a-f]+|virbr\d+(-nic)?|cali.*|flannel.*|cni\d*|cilium.*|lxcbr\d*|lxdbr\d*|tailscale\d*|zt.*)$"
)
# Punkty montowania, które nie są dyskami do pilnowania
_SKIP_MOUNT_PREFIXES = (
    "/run",
    "/dev",
    "/sys",
    "/proc",
    "/snap",
    "/var/lib/docker",
    "/var/lib/containers",
    "/var/lib/kubelet",
    "/var/snap",
    "/boot/efi",
)


def parse_kernel(descr: str | None) -> str | None:
    """Wersja jądra z `sysDescr` w postaci „Linux host 6.8.0-45-generic #45 …”."""
    parts = (descr or "").split()
    return parts[2] if len(parts) >= 3 and parts[0] == "Linux" else None


def is_real_mount(mount: str) -> bool:
    return not mount.startswith(_SKIP_MOUNT_PREFIXES) and not mount.startswith("Memory") and mount != "Swap space"


class LinuxDriver(GenericDriver):
    name = "linux"
    vendor = "Linux"

    @classmethod
    def match(cls, system: SystemInfo) -> int:
        descr = system.descr or ""
        if descr.startswith("Linux ") and (system.object_id or "").startswith(_LINUX_AGENT):
            return 50  # producenci z własnym driverem (UniFi) dostają 60 i więcej
        return 40 if descr.startswith("Linux ") else 0

    async def poll(self, client: SnmpClient, system: SystemInfo | None = None) -> PollResult:
        result = await super().poll(client, system)
        result.disks = await self.read_disks(client)
        result.server = await self.read_server(client)
        return result

    async def read_disks(self, client: SnmpClient) -> list[DiskSample]:
        types = await client.walk(O.HR_STORAGE_TYPE)
        if not types:
            return []
        descr = await client.walk(O.HR_STORAGE_DESCR)
        units = await client.walk(O.HR_STORAGE_UNITS)
        size = await client.walk(O.HR_STORAGE_SIZE)
        used = await client.walk(O.HR_STORAGE_USED)
        disks: list[DiskSample] = []
        for idx, kind in sorted(types.items(), key=lambda kv: int(kv[0])):
            if (as_str(kind) or "").lstrip(".") != O.HR_STORAGE_FIXED_DISK:
                continue
            mount = as_str(descr.get(idx))
            unit, total, taken = as_int(units.get(idx)), as_int(size.get(idx)), as_int(used.get(idx))
            if not mount or not is_real_mount(mount) or not unit or not total or taken is None:
                continue
            disks.append(DiskSample(mount=mount[:255], total_bytes=total * unit, used_bytes=taken * unit))
        return disks

    async def read_server(self, client: SnmpClient) -> ServerSample:
        v = await client.get([O.UCD_MEM_TOTAL_SWAP, O.UCD_MEM_AVAIL_SWAP, O.HR_SYSTEM_PROCESSES])
        swap_total = as_int(v.get(O.UCD_MEM_TOTAL_SWAP))
        swap_free = as_int(v.get(O.UCD_MEM_AVAIL_SWAP))
        swap = None
        if swap_total and swap_free is not None:
            swap = round(100.0 * max(swap_total - swap_free, 0) / swap_total, 1)
        return ServerSample(swap_used_percent=swap, processes=as_int(v.get(O.HR_SYSTEM_PROCESSES)))

    def enrich_system(self, result: PollResult) -> None:
        kernel = parse_kernel(result.system.descr)
        result.system.kind = "server"
        result.system.vendor = self.vendor
        result.system.model = f"Linux {kernel}" if kernel else "Linux"
        result.system.firmware = kernel

    def enrich_interface(self, iface: InterfaceSample, result: PollResult) -> None:
        super().enrich_interface(iface, result)
        if _VIRTUAL_IF.match(iface.name):
            iface.role, iface.hidden = "virtual", True
        elif iface.role == "port":
            iface.role = "lan"
