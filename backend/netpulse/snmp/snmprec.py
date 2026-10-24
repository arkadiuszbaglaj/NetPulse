"""Klient SNMP czytający plik .snmprec (format snmpsim).

Pozwala testować drivery bez sieci – na zrzutach z prawdziwych urządzeń.
Format linii: `OID|TAG|wartość`, np. `1.3.6.1.2.1.1.5.0|4|switch`.
Tagi: 2 Integer, 4 OctetString (4x = hex), 6 OID, 64 IpAddress,
65 Counter32, 66 Gauge32, 67 TimeTicks, 70 Counter64.
"""

from __future__ import annotations

from pathlib import Path

from .types import SnmpValue

_INT_TAGS = {"2", "65", "66", "67", "70"}


def parse_snmprec(text: str) -> dict[str, SnmpValue]:
    data: dict[str, SnmpValue] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        oid, tag, value = line.split("|", 2)
        if tag in _INT_TAGS:
            data[oid] = int(value)
        elif tag == "4":
            data[oid] = value.encode()
        elif tag == "4x":
            data[oid] = bytes.fromhex(value)
        elif tag in ("6", "64"):
            data[oid] = value
        else:
            data[oid] = value.encode()
    return data


def _oid_key(oid: str) -> tuple[int, ...]:
    return tuple(int(p) for p in oid.split("."))


class SnmprecClient:
    """Implementacja `SnmpClient` na danych z pliku .snmprec."""

    def __init__(self, data: dict[str, SnmpValue]) -> None:
        self._data = data

    @classmethod
    def from_file(cls, path: str | Path) -> SnmprecClient:
        return cls(parse_snmprec(Path(path).read_text()))

    async def get(self, oids: list[str]) -> dict[str, SnmpValue]:
        return {oid: self._data[oid] for oid in oids if oid in self._data}

    async def walk(self, oid: str) -> dict[str, SnmpValue]:
        prefix = oid.strip(".") + "."
        items = sorted(
            ((k, v) for k, v in self._data.items() if k.startswith(prefix)),
            key=lambda kv: _oid_key(kv[0]),
        )
        return {k[len(prefix) :]: v for k, v in items}

    def set(self, oid: str, value: SnmpValue) -> None:
        """Do testów: zmiana wartości (np. przyrost liczników)."""
        self._data[oid] = value

    async def close(self) -> None:
        return None
