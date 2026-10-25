"""Driver TP-Link (urządzenia Omada i JetStream: switche, access pointy EAP, routery ER).

Na bazie drivera generycznego (IF-MIB). Rozpoznaje producenta po identyfikatorze przedsiębiorstwa TP-Link
albo opisie systemu, typ urządzenia po modelu (EAP = access point, ER = router, reszta = switch) i nadaje
portom czytelne nazwy „Port N” z numeru na końcu nazwy interfejsu (np. `gi1/0/12`, `gigabitEthernet 1/0/12`).
Dane z kontrolera Omada (klienci, PoE) nie są jeszcze obsługiwane: to osobny etap."""

from __future__ import annotations

import re

from ..snmp import oids as O
from .base import InterfaceSample, PollResult, SystemInfo
from .generic import GenericDriver

_MODEL = re.compile(r"\b((?:TL-)?(?:SG|SX|SL|TL-SG|EAP|ER|OC|SR)\d{2,4}[A-Z0-9\-]*)\b", re.IGNORECASE)
_TRAILING_NUMBER = re.compile(r"(\d+)\s*$")
_TECHNICAL = re.compile(r"^(vlan\s?\d+|loopback\d*|lo\d*|null\d*|cpu|mgmt\d*)$", re.IGNORECASE)
_LAG = re.compile(r"^(lag|port-channel|po)\s?(\d+)$", re.IGNORECASE)
_RADIO = re.compile(r"^(ra|rai|wlan|wifi|ath)\d*$", re.IGNORECASE)


class OmadaDriver(GenericDriver):
    name = "omada"
    vendor = "TP-Link"

    @classmethod
    def match(cls, system: SystemInfo) -> int:
        if (system.object_id or "").startswith(O.TPLINK_ENTERPRISE):
            return 100
        descr = (system.descr or "").lower()
        return 80 if "tp-link" in descr or "omada" in descr or "jetstream" in descr else 0

    def enrich_system(self, result: PollResult) -> None:
        system = result.system
        system.vendor = self.vendor
        descr = system.descr or ""
        m = _MODEL.search(descr) or _MODEL.search(system.name or "")
        system.model = (m.group(1).upper() if m else descr.strip())[:64] or None
        upper = f"{system.model or ''} {descr}".upper()
        if "EAP" in upper or "ACCESS POINT" in upper:
            system.kind = "ap"
        elif re.search(r"\bER\d{3}\b", upper) or "ROUTER" in upper:
            system.kind = "gateway"
        else:
            system.kind = "switch"

    def enrich_interface(self, iface: InterfaceSample, result: PollResult) -> None:
        name = iface.name.strip()
        if iface.alias and iface.alias in (iface.name, iface.descr):
            iface.alias = None

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
