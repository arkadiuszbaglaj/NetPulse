"""Zanonimizowany raport urządzenia (od 0.73.0, część B z `docs/24-wykrywanie-propozycja.md`).

Zrzut SNMP ważnych gałęzi (system, IF-MIB, HOST-RESOURCES, ENTITY, czujniki, UCD, BRIDGE, LLDP, PoE i gałąź producenta
z `sysObjectID`) w formacie .snmprec – tym samym, co fixtures w `backend/tests/fixtures/`. Drugi odczyt po `interval_s`
pokazuje, które wartości to liczniki. Anonimizacja odbywa się tu, na serwerze użytkownika, zanim cokolwiek opuści
NetPulse: MAC-i, adresy IP, `sysName`, `sysContact`, `sysLocation`, `ifAlias`, nazwy sąsiadów LLDP, SSID, numery
seryjne i adresy e-mail. Community i klucze SNMPv3 nigdy nie trafiają do raportu, adres urządzenia też nie.
Tablice adresowane adresami (MAC, ARP, trasy, procesy) nie są w ogóle czytane.
"""

from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import re
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime

from . import __version__
from .drivers import detect_driver
from .drivers.generic import read_system
from .snmp import SnmpClient, SnmpError

FORMAT = "netpulse-device-report"

# (OID gałęzi, opis, limit wartości)
BRANCHES: tuple[tuple[str, str, int], ...] = (
    ("1.3.6.1.2.1.1", "SNMPv2-MIB::system", 50),
    ("1.3.6.1.2.1.2", "IF-MIB::interfaces", 6000),
    ("1.3.6.1.2.1.31.1.1", "IF-MIB::ifXTable", 6000),
    ("1.3.6.1.2.1.25.1", "HOST-RESOURCES-MIB::hrSystem", 50),
    ("1.3.6.1.2.1.25.2", "HOST-RESOURCES-MIB::hrStorage", 1000),
    ("1.3.6.1.2.1.25.3", "HOST-RESOURCES-MIB::hrDevice", 1500),
    ("1.3.6.1.2.1.47.1.1.1", "ENTITY-MIB::entPhysicalTable", 2000),
    ("1.3.6.1.2.1.99.1.1", "ENTITY-SENSOR-MIB::entPhySensorTable", 1000),
    ("1.3.6.1.4.1.2021.4", "UCD-SNMP-MIB::memory", 50),
    ("1.3.6.1.4.1.2021.9", "UCD-SNMP-MIB::dskTable", 500),
    ("1.3.6.1.4.1.2021.10", "UCD-SNMP-MIB::laTable", 50),
    ("1.3.6.1.4.1.2021.11", "UCD-SNMP-MIB::systemStats", 100),
    ("1.3.6.1.2.1.17.1", "BRIDGE-MIB::dot1dBase", 500),
    ("1.0.8802.1.1.2.1.3", "LLDP-MIB::lldpLocalSystemData", 500),
    ("1.0.8802.1.1.2.1.4.1", "LLDP-MIB::lldpRemTable", 500),
    ("1.3.6.1.2.1.105.1", "POWER-ETHERNET-MIB", 1000),
)
VENDOR_LIMIT = 8000
TOTAL_LIMIT = 30000
DEADLINE_S = 90.0

# Gałęzie wewnątrz gałęzi producenta, których nie czytamy (adresy klientów, sesje)
SKIP_PREFIXES = (
    "1.3.6.1.4.1.41112.1.6.1.3",  # UniFi: tabela klientów WiFi (MAC-i, nazwy)
    "1.3.6.1.4.1.14988.1.1.1.2",  # MikroTik: rejestracje WiFi (MAC-i klientów)
)

SYS_DESCR = "1.3.6.1.2.1.1.1.0"
SYS_OBJECT_ID = "1.3.6.1.2.1.1.2.0"
SYS_CONTACT = "1.3.6.1.2.1.1.4.0"
SYS_NAME = "1.3.6.1.2.1.1.5.0"
SYS_LOCATION = "1.3.6.1.2.1.1.6.0"
SYS_OR = "1.3.6.1.2.1.1.9."
IF_ALIAS = "1.3.6.1.2.1.31.1.1.1.18."
IF_PHYS = "1.3.6.1.2.1.2.2.1.6."
ENT_SERIAL = "1.3.6.1.2.1.47.1.1.1.1.11."
ENT_ALIAS = "1.3.6.1.2.1.47.1.1.1.1.14."
ENT_ASSET = "1.3.6.1.2.1.47.1.1.1.1.15."
LLDP_LOC_SYSNAME = "1.0.8802.1.1.2.1.3.3."
LLDP_REM_SYSNAME = "1.0.8802.1.1.2.1.4.1.1.9."
LLDP_REM_PORTDESC = "1.0.8802.1.1.2.1.4.1.1.8."
# SSID w gałęziach producentów
SSID_PREFIXES = ("1.3.6.1.4.1.41112.1.6.1.2.1.6.", "1.3.6.1.4.1.14988.1.1.1.3.1.4.")
# Numery seryjne w gałęziach producentów
SERIAL_OIDS = ("1.3.6.1.4.1.14988.1.1.7.3.0",)

_IPV4 = re.compile(r"(?<![\d.])((?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3})(?![\d.])")
_MAC = re.compile(r"(?i)(?<![0-9a-f])([0-9a-f]{2}([:-])(?:[0-9a-f]{2}\2){4}[0-9a-f]{2})(?![0-9a-f])")
_EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
_INT_TAGS = {"2", "65", "66", "67", "70"}


def _keep_ip(ip: str) -> bool:
    """Adresy, które nic nie mówią o sieci użytkownika: 0.0.0.0, maski, pętla zwrotna, rozgłoszenie."""
    try:
        a = ipaddress.IPv4Address(ip)
    except ValueError:
        return True
    return a.is_unspecified or a.is_loopback or str(a).startswith("255.") or a.is_multicast


@dataclass
class Anonymizer:
    """Spójna podmiana: ten sam prawdziwy adres zawsze daje ten sam zastępczy (relacje w zrzucie zostają)."""

    names: set[str] = field(default_factory=set)
    _ips: dict[str, str] = field(default_factory=dict)
    _macs: dict[bytes, bytes] = field(default_factory=dict)
    _texts: dict[str, str] = field(default_factory=dict)

    def ip(self, real: str) -> str:
        if _keep_ip(real):
            return real
        if real not in self._ips:
            n = len(self._ips) + 1
            self._ips[real] = f"198.18.{n // 250}.{n % 250 + 1}"  # zakres testowy RFC 2544
        return self._ips[real]

    def mac(self, real: bytes) -> bytes:
        if real in (b"\x00" * 6, b"\xff" * 6):
            return real
        if real not in self._macs:
            self._macs[real] = bytes([0x02]) + hashlib.sha256(b"netpulse-report" + real).digest()[:5]
        return self._macs[real]

    def text(self, real: str, prefix: str) -> str:
        if not real:
            return real
        if real not in self._texts:
            self._texts[real] = f"{prefix}-{sum(1 for v in self._texts.values() if v.startswith(prefix + '-')) + 1}"
        return self._texts[real]

    def ssid(self, real: str) -> str:
        """SSID → `ssid-N`; wewnętrzne sieci UniFi (`element-*`, `vwire-*`) zachowują przedrostek – po nim driver je ukrywa."""
        for internal in ("element-", "vwire-"):
            if real.startswith(internal):
                return self._texts.setdefault(real, internal + hashlib.sha256(real.encode()).hexdigest()[:12])
        return self.text(real, "ssid")

    def scrub(self, s: str) -> str:
        """Tekst: adresy IP i MAC, e-mail i znane nazwy (sysName, sąsiedzi) zastąpione."""
        for name in sorted(self.names, key=len, reverse=True):
            if len(name) >= 3:
                s = re.sub(re.escape(name), self._texts.get(name, "device"), s, flags=re.IGNORECASE)
        s = _EMAIL.sub("user@example.com", s)
        s = _MAC.sub(lambda m: ":".join(f"{b:02x}" for b in self.mac(bytes.fromhex(re.sub("[:-]", "", m.group(1))))), s)
        return _IPV4.sub(lambda m: self.ip(m.group(1)), s)

    def index(self, oid: str, branch: str) -> str:
        """Indeks tabeli z adresem MAC (6 liczb ≤ 255) albo znanym IP (4 liczby) – zastąpiony."""
        if not oid.startswith(branch + "."):
            return oid
        head, tail = branch, oid[len(branch) + 1 :].split(".")
        try:
            nums = [int(p) for p in tail]
        except ValueError:
            return oid
        known_ips = {tuple(int(x) for x in ip.split(".")) for ip in self._ips}
        known_macs = {tuple(m) for m in self._macs}
        out: list[int] = []
        i = 0
        while i < len(nums):
            six, four = tuple(nums[i : i + 6]), tuple(nums[i : i + 4])
            if len(six) == 6 and (six in known_macs or (i + 6 == len(nums) and i >= 2 and all(n <= 255 for n in six) and sum(n > 15 for n in six) >= 3)):
                out.extend(self.mac(bytes(six)))
                i += 6
            elif len(four) == 4 and four in known_ips:
                out.extend(int(p) for p in self.ip(".".join(map(str, four))).split("."))
                i += 4
            else:
                out.append(nums[i])
                i += 1
        return head + "." + ".".join(map(str, out))


def _printable(raw: bytes) -> bool:
    return all(32 <= b < 127 or b in (9, 10, 13) for b in raw)


def anonymize(records: list[tuple[str, str, str]], anon: Anonymizer, branch_of) -> list[tuple[str, str, str]]:
    """Rekordy .snmprec po anonimizacji (wartości i indeksy tabel)."""
    out = []
    for oid, tag, value in records:
        if oid.startswith(SYS_OR):
            continue
        if tag == "64":
            value = anon.ip(value)
        elif tag == "4x":
            raw = bytes.fromhex(value)
            if oid in (SYS_NAME,) or oid.startswith(LLDP_LOC_SYSNAME):
                raw = b"device" if raw else raw
            elif oid in (SYS_CONTACT, SYS_LOCATION):
                raw = b"homelab" if raw else raw
            elif oid.startswith((IF_ALIAS, ENT_ALIAS, ENT_ASSET)):
                raw = f"alias-{oid.rsplit('.', 1)[1]}".encode() if raw else raw
            elif oid.startswith(ENT_SERIAL) or oid in SERIAL_OIDS:
                raw = b"SERIAL" if raw else raw
            elif oid.startswith(SSID_PREFIXES):
                raw = anon.ssid(raw.decode(errors="replace")).encode() if raw else raw
            elif oid.startswith(LLDP_REM_SYSNAME):
                raw = anon.text(raw.decode(errors="replace"), "neighbor").encode() if raw else raw
            elif oid.startswith(LLDP_REM_PORTDESC):
                raw = b"port" if raw else raw
            elif len(raw) == 6 and (oid.startswith(IF_PHYS) or not _printable(raw)):
                raw = anon.mac(raw)
            elif len(raw) == 4 and not _printable(raw) and not _keep_ip(".".join(map(str, raw))):
                raw = bytes(int(p) for p in anon.ip(".".join(map(str, raw))).split("."))
            elif _printable(raw):
                raw = anon.scrub(raw.decode()).encode()
            value = raw.hex()
        out.append((anon.index(oid, branch_of(oid)), tag, value))
    return out


def _collect_names(records: list[tuple[str, str, str]], anon: Anonymizer) -> None:
    """Pierwsze przejście: nazwy, SSID i adresy do spójnej podmiany także w innych tekstach i indeksach."""
    for oid, tag, value in records:
        if tag == "64":
            anon.ip(value)
        elif tag == "4x":
            raw = bytes.fromhex(value)
            text = raw.decode(errors="replace").strip() if _printable(raw) else ""
            if oid == SYS_NAME or oid.startswith(LLDP_LOC_SYSNAME):
                if text:
                    anon.names.add(text)
                    anon._texts.setdefault(text, "device")
            elif oid.startswith(LLDP_REM_SYSNAME) and text:
                anon.names.add(text)
                anon.text(text, "neighbor")
            elif oid.startswith(SSID_PREFIXES) and text:
                anon.names.add(text)
                anon.ssid(text)
            elif len(raw) == 6 and (oid.startswith(IF_PHYS) or not _printable(raw)):
                anon.mac(raw)


async def _typed_walk(client: SnmpClient, oid: str, limit: int) -> list[tuple[str, str, str]]:
    walk_typed = getattr(client, "walk_typed", None)
    if walk_typed is not None:
        return await walk_typed(oid, limit=limit)
    # Klient bez typów (testy na .snmprec): typ z wartości
    out = []
    for suffix, v in (await client.walk(oid)).items():
        full = f"{oid}.{suffix}"
        if isinstance(v, int):
            out.append((full, "2", str(v)))
        elif isinstance(v, bytes):
            out.append((full, "4x", v.hex()))
        elif re.fullmatch(r"\d+\.\d+\.\d+\.\d+", v):
            out.append((full, "64", v))
        else:
            out.append((full, "6", v.lstrip(".")))
        if len(out) >= limit:
            break
    return out


def vendor_branch(object_id: str | None) -> str | None:
    """Gałąź producenta z `sysObjectID`: 1.3.6.1.4.1.<numer> (bez net-snmp – to UCD, czytany osobno)."""
    m = re.match(r"^\.?1\.3\.6\.1\.4\.1\.(\d+)", object_id or "")
    if not m or m.group(1) in ("8072", "2021"):
        return None
    return f"1.3.6.1.4.1.{m.group(1)}"


async def _read(client: SnmpClient, branches: list[tuple[str, str, int]], deadline: float) -> tuple[list[tuple[str, str, str]], list[dict]]:
    records: list[tuple[str, str, str]] = []
    info: list[dict] = []
    for oid, label, limit in branches:
        left = deadline - time.monotonic()
        room = TOTAL_LIMIT - len(records)
        if left <= 0 or room <= 0:
            info.append({"oid": oid, "name": label, "records": 0, "truncated": True, "error": "limit czasu lub rozmiaru"})
            continue
        try:
            got = await asyncio.wait_for(_typed_walk(client, oid, min(limit, room)), timeout=left)
        except TimeoutError:
            info.append({"oid": oid, "name": label, "records": 0, "truncated": True, "error": "limit czasu"})
            continue
        except SnmpError as exc:
            info.append({"oid": oid, "name": label, "records": 0, "truncated": False, "error": str(exc)[:200]})
            continue
        got = [r for r in got if not r[0].startswith(SKIP_PREFIXES)]
        records.extend(got)
        info.append({"oid": oid, "name": label, "records": len(got), "truncated": len(got) >= min(limit, room)})
    return records, info


def to_snmprec(records: list[tuple[str, str, str]]) -> str:
    def key(r):
        return tuple(int(p) for p in r[0].split("."))

    return "".join(f"{o}|{t}|{v}\n" for o, t, v in sorted(records, key=key))


async def build(client: SnmpClient, driver: str | None = None, interval_s: float = 30.0) -> dict:
    """Pełny raport: dwa odczyty w odstępie `interval_s`, anonimizacja, metadane. Zwraca słownik gotowy do JSON."""
    started = time.monotonic()
    system = await read_system(client)
    if system.descr is None and system.name is None and system.object_id is None:
        raise SnmpError("Urządzenie nie zwróciło danych SNMPv2-MIB::system")
    detected = detect_driver(system)
    branches = list(BRANCHES)
    vendor = vendor_branch(system.object_id)
    if vendor:
        branches.append((vendor, f"gałąź producenta ({vendor})", VENDOR_LIMIT))
    deadline = started + DEADLINE_S
    first, info = await _read(client, branches, deadline)
    second: list[tuple[str, str, str]] = []
    if interval_s > 0:
        await asyncio.sleep(interval_s)
        numeric = [b for b in branches if any(r[0].startswith(b[0] + ".") and r[1] in _INT_TAGS for r in first)]
        second, _ = await _read(client, numeric, time.monotonic() + DEADLINE_S)

    prefixes = sorted((b[0] for b in branches), key=len, reverse=True)

    def branch_of(oid: str) -> str:
        return next((p for p in prefixes if oid.startswith(p + ".")), oid)

    anon = Anonymizer()
    _collect_names(first, anon)
    # Nazwa, która jest częścią opisu systemu (np. „UCG-Ultra” w „UniFi UCG-Ultra 4.1…”), to model, nie nazwa prywatna
    descr_low = (system.descr or "").lower()
    anon.names = {n for n in anon.names if n.lower() not in descr_low}
    walk = anonymize(first, anon, branch_of)
    before = {o: (t, v) for o, t, v in first}
    changed = [(o, t, v) for o, t, v in second if t in _INT_TAGS and o in before and before[o][1] != v]
    changes = anonymize(changed, anon, branch_of)
    descr = anon.scrub(system.descr or "")
    return {
        "format": FORMAT,
        "format_version": 1,
        "netpulse": __version__,
        "created_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "interval_s": interval_s,
        "device": {
            "sys_object_id": system.object_id,
            "sys_descr": descr or None,
            "detected_driver": detected.name,
            "driver": driver,
            "uptime_s": system.uptime_s,
        },
        "branches": info,
        "records": len(walk),
        "changed": len(changes),
        "walk": to_snmprec(walk),
        "walk2_changes": to_snmprec(changes),
        "notes": "",
    }
