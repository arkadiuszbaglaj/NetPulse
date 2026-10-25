"""Klient UniFi Network API (klucz API) i parsery odpowiedzi.

SNMP nie podaje PoE na portach ani listy klientów, więc czytamy je z kontrolera. Używamy API
`/proxy/network/api/s/<site>/stat/...` (działa z nagłówkiem X-API-KEY): tylko ono ma moc PoE w watach,
sygnał klientów i ich porty. API integracji (`/proxy/network/integration/v1`) służy do sprawdzenia
połączenia i wersji aplikacji. Oba nie są stabilnym kontraktem producenta, dlatego parsery są
tolerancyjne: brak pola daje None, a nie błąd.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import httpx


class UnifiError(Exception):
    """Błąd rozmowy z kontrolerem (sieć, TLS, klucz API, nieoczekiwana odpowiedź)."""


@dataclass(frozen=True)
class PoePort:
    port_idx: int
    name: str | None
    up: bool
    poe_mode: str | None
    poe_class: str | None
    delivering: bool
    power_w: float | None
    voltage_v: float | None
    current_ma: float | None


@dataclass(frozen=True)
class UnifiDevice:
    type: str  # usw | uap | udm | ugw …
    name: str | None
    model: str | None
    mac: str
    ip: str | None
    state: int | None
    poe_used_w: float | None = None
    poe_max_w: float | None = None
    poe_ports: list[PoePort] = field(default_factory=list)


@dataclass(frozen=True)
class UnifiClient:
    mac: str
    name: str | None
    ip: str | None
    is_wired: bool
    is_guest: bool
    essid: str | None
    radio: str | None
    signal_dbm: int | None
    tx_rate_kbps: int | None
    rx_rate_kbps: int | None
    uplink_mac: str | None  # AP (WiFi) albo switch/router (kabel)
    uplink_port: int | None
    connected_s: int | None


def _float(v: Any) -> float | None:
    try:
        return float(v) if v not in (None, "") else None
    except (TypeError, ValueError):
        return None


def _int(v: Any) -> int | None:
    f = _float(v)
    return int(f) if f is not None else None


def _str(v: Any) -> str | None:
    return v.strip() or None if isinstance(v, str) else None


def parse_devices(raw: dict) -> list[UnifiDevice]:
    """`stat/device` → urządzenia z PoE portów (tylko porty, które mają PoE)."""
    out: list[UnifiDevice] = []
    for d in raw.get("data", []):
        mac = _str(d.get("mac"))
        if not mac:
            continue
        ports = [
            PoePort(
                port_idx=int(p["port_idx"]),
                name=_str(p.get("name")),
                up=bool(p.get("up")),
                poe_mode=_str(p.get("poe_mode")),
                poe_class=_str(p.get("poe_class")),
                delivering=bool(p.get("poe_good")) and (_float(p.get("poe_power")) or 0) > 0,
                power_w=_float(p.get("poe_power")),
                voltage_v=_float(p.get("poe_voltage")),
                current_ma=_float(p.get("poe_current")),
            )
            for p in d.get("port_table", [])
            if p.get("port_poe") and "port_idx" in p
        ]
        out.append(
            UnifiDevice(
                type=str(d.get("type") or ""),
                name=_str(d.get("name")),
                model=_str(d.get("model")),
                mac=mac.lower(),
                ip=_str(d.get("ip")),
                state=_int(d.get("state")),
                poe_used_w=_float(d.get("total_used_power")),
                poe_max_w=_float(d.get("total_max_power")),
                poe_ports=ports,
            )
        )
    return out


def parse_clients(raw: dict) -> list[UnifiClient]:
    """`stat/sta` → klienci. Nazwa: nadana w UniFi, potem nazwa hosta; port tylko dla klientów po kablu."""
    out: list[UnifiClient] = []
    for s in raw.get("data", []):
        mac = _str(s.get("mac"))
        if not mac:
            continue
        wired = bool(s.get("is_wired"))
        out.append(
            UnifiClient(
                mac=mac.lower(),
                name=_str(s.get("name")) or _str(s.get("hostname")),
                ip=_str(s.get("ip")) or _str(s.get("last_ip")),
                is_wired=wired,
                is_guest=bool(s.get("is_guest")),
                essid=None if wired else _str(s.get("essid")),
                radio=None if wired else _str(s.get("radio")),
                signal_dbm=None if wired else _int(s.get("signal")),
                tx_rate_kbps=None if wired else _int(s.get("tx_rate")),
                rx_rate_kbps=None if wired else _int(s.get("rx_rate")),
                uplink_mac=(_str(s.get("sw_mac")) if wired else _str(s.get("ap_mac"))) or None,
                uplink_port=_int(s.get("sw_port")) if wired else None,
                connected_s=_int(s.get("uptime")),
            )
        )
    return out


class UnifiApi:
    def __init__(self, host: str, api_key: str, *, port: int = 443, site: str = "default", verify_tls: bool = False, timeout: float = 10.0, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.base = f"https://{host}:{port}/proxy/network"
        self.site = site
        self._client = httpx.AsyncClient(headers={"X-API-KEY": api_key, "Accept": "application/json"}, verify=verify_tls, timeout=timeout, transport=transport)

    async def _get(self, path: str) -> dict:
        try:
            res = await self._client.get(self.base + path)
        except httpx.HTTPError as exc:
            raise UnifiError(f"Brak połączenia z kontrolerem: {type(exc).__name__}: {exc}") from exc
        if res.status_code in (401, 403):
            raise UnifiError("Kontroler odrzucił klucz API (sprawdź klucz i jego uprawnienia)")
        if res.status_code == 404:
            raise UnifiError(f"Kontroler nie zna adresu {path} (nieobsługiwana wersja UniFi Network albo zła nazwa site)")
        if res.status_code != 200:
            raise UnifiError(f"Kontroler odpowiedział kodem {res.status_code}")
        try:
            data = res.json()
        except ValueError as exc:
            raise UnifiError("Kontroler zwrócił odpowiedź, która nie jest JSON-em") from exc
        if not isinstance(data, dict):
            raise UnifiError("Nieoczekiwany format odpowiedzi kontrolera")
        return data

    async def app_version(self) -> str | None:
        return _str((await self._get("/integration/v1/info")).get("applicationVersion"))

    async def devices(self) -> list[UnifiDevice]:
        return parse_devices(await self._get(f"/api/s/{self.site}/stat/device"))

    async def clients(self) -> list[UnifiClient]:
        return parse_clients(await self._get(f"/api/s/{self.site}/stat/sta"))

    async def close(self) -> None:
        await self._client.aclose()
