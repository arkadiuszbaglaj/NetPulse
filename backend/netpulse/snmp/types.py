"""Wspólne typy SNMP niezależne od biblioteki (pysnmp / plik snmpwalk)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Protocol

# Wartość SNMP po normalizacji:
#   int   – INTEGER, Counter32/64, Gauge32, TimeTicks
#   bytes – OCTET STRING (tekst lub dane binarne, np. MAC)
#   str   – OID, IpAddress, Opaque
SnmpValue = int | bytes | str


class SnmpError(Exception):
    """Błąd komunikacji SNMP (timeout, zła community, brak odpowiedzi)."""


@dataclass(frozen=True)
class SnmpCredentials:
    version: Literal["1", "2c", "3"] = "2c"
    community: str = "public"
    # SNMPv3 (USM)
    username: str | None = None
    auth_protocol: Literal["MD5", "SHA", "SHA224", "SHA256", "SHA384", "SHA512"] | None = None
    auth_key: str | None = field(default=None, repr=False)
    priv_protocol: Literal["DES", "AES", "AES192", "AES256"] | None = None
    priv_key: str | None = field(default=None, repr=False)
    context_name: str = ""

    @property
    def security_level(self) -> str:
        if self.version != "3":
            return "community"
        if self.auth_protocol and self.priv_protocol:
            return "authPriv"
        if self.auth_protocol:
            return "authNoPriv"
        return "noAuthNoPriv"


class SnmpClient(Protocol):
    """Minimalny interfejs klienta SNMP używany przez drivery."""

    async def get(self, oids: list[str]) -> dict[str, SnmpValue]:
        """Zwraca {oid: wartość}; brakujące OID-y są pomijane."""
        ...

    async def walk(self, oid: str) -> dict[str, SnmpValue]:
        """Zwraca {sufiks_indeksu: wartość} dla poddrzewa `oid`."""
        ...

    async def close(self) -> None: ...


# --- pomocnicze konwersje -------------------------------------------------


def as_int(v: SnmpValue | None) -> int | None:
    if v is None:
        return None
    if isinstance(v, int):
        return v
    try:
        s = v.decode() if isinstance(v, bytes) else v
        return int(float(s))
    except (ValueError, UnicodeDecodeError):
        return None


def as_float(v: SnmpValue | None) -> float | None:
    if v is None:
        return None
    if isinstance(v, int):
        return float(v)
    try:
        s = v.decode() if isinstance(v, bytes) else v
        return float(s)
    except (ValueError, UnicodeDecodeError):
        return None


def as_str(v: SnmpValue | None) -> str | None:
    if v is None:
        return None
    if isinstance(v, bytes):
        return v.decode("utf-8", errors="replace").strip("\x00").strip()
    return str(v)


def as_mac(v: SnmpValue | None) -> str | None:
    if isinstance(v, bytes) and len(v) == 6:
        return ":".join(f"{b:02x}" for b in v)
    return None
