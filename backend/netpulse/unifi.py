"""Klient UniFi Network API (klucz API) i parsery odpowiedzi.

SNMP nie podaje PoE na portach ani listy klientów, więc czytamy je z kontrolera. Dwa API:

- **Oficjalne** (`/proxy/network/integration/v1`, opis: developer.ui.com, wersja 11.0.97 z plikiem OpenAPI):
  wersja aplikacji, lista urządzeń, porty (stan, prędkość, stan PoE), CPU, RAM, load, uptime. Od 0.52.0 z niego
  bierzemy urządzenia, których NetPulse nie zna z SNMP (np. switche USW Flex i Ultra – nie mają SNMP).
- **Starsze** `/proxy/network/api/s/<site>/stat/...` (ten sam klucz): moc PoE w watach, sygnał klientów i ich
  porty, LLDP, stan WAN i liczniki ruchu portów – tego oficjalne API nadal nie podaje.

Parsery są tolerancyjne: brak pola daje None, a nie błąd.
"""

from __future__ import annotations

import re
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
class LldpLink:
    """Sąsiad widziany przez LLDP na porcie urządzenia."""

    local_port_idx: int
    remote_mac: str
    remote_ips: tuple[str, ...] = ()  # adresy IPv4 sąsiada z LLDP (adres w sieci LAN, nie ten z pola `ip` kontrolera)


@dataclass(frozen=True)
class WanPort:
    """Port WAN bramy według kontrolera: nazwa interfejsu (jak `ifName` z SNMP), czy działa i czy idzie nim ruch."""

    ifname: str
    up: bool | None
    active: bool
    slot: int | None = field(default=None, compare=False)  # numer łącza w UniFi (wan = 1, wan2 = 2 …)


@dataclass(frozen=True)
class PortStats:
    """Port urządzenia ze starszego `stat/device` (`port_table`): liczniki ruchu – oficjalne API ich nie ma."""

    port_idx: int
    name: str | None
    up: bool | None
    speed_mbps: int | None
    rx_bytes: int | None
    tx_bytes: int | None
    rx_errors: int | None = None
    tx_errors: int | None = None
    rx_dropped: int | None = None
    tx_dropped: int | None = None


@dataclass(frozen=True)
class OfficialPort:
    idx: int
    state: str  # UP | DOWN | UNKNOWN
    connector: str | None
    speed_mbps: int | None
    max_speed_mbps: int | None
    poe_enabled: bool | None = None
    poe_state: str | None = None  # UP | DOWN | LIMITED | UNKNOWN


@dataclass(frozen=True)
class OfficialDevice:
    """Urządzenie z oficjalnego Network API: przegląd z listy, a po `details()` także porty i statystyki."""

    id: str
    mac: str
    ip: str | None
    name: str | None
    model: str | None
    state: str | None  # ONLINE | OFFLINE | UPDATING | …
    firmware: str | None
    features: tuple[str, ...] = ()  # switching | accessPoint | gateway
    ports: tuple[OfficialPort, ...] = ()
    radios: tuple[dict, ...] = ()
    uptime_s: int | None = None
    cpu_percent: float | None = None
    mem_percent: float | None = None
    load1: float | None = None
    load5: float | None = None
    load15: float | None = None

    @property
    def online(self) -> bool:
        return self.state == "ONLINE"

    @property
    def kind(self) -> str:
        if "gateway" in self.features:
            return "gateway"
        if "switching" in self.features:
            return "switch"
        if "accessPoint" in self.features:
            return "ap"
        return "other"


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
    lldp: list[LldpLink] = field(default_factory=list)
    macs: tuple[str, ...] = ()  # wszystkie adresy MAC interfejsów urządzenia (ethernet_table)
    wans: tuple[WanPort, ...] = ()  # tylko bramy: porty WAN i który jest uplinkiem (dual WAN / failover)
    ports: tuple[PortStats, ...] = ()  # wszystkie porty z licznikami ruchu (urządzenia bez SNMP)


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


GATEWAY_TYPES = ("udm", "ugw", "uxg", "ucg")
WAN_KEY_RE = re.compile(r"^wan(\d*)$")
IFNAME_RE = re.compile(r"^[a-z][\w.\-]*\d$")
MAC_RE = re.compile(r"^[0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5}$")
IPV4_RE = re.compile(r"^\d{1,3}(?:\.\d{1,3}){3}$")


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


def _port_ifname(p: dict) -> str | None:
    """Nazwa interfejsu portu bramy; starsze odpowiedzi jej nie mają – wtedy port N to ethN-1 (jak na UCG/UDM)."""
    name = _str(p.get("ifname"))
    if name:
        return name
    idx = _int(p.get("port_idx"))
    return f"eth{idx - 1}" if idx else None


def _slot(key: str) -> int | None:
    """Numer łącza z nazwy UniFi: `wan` / `wan1` = 1, `wan2` = 2; inna nazwa – brak."""
    m = WAN_KEY_RE.match(key)
    return int(m.group(1) or 1) if m else None


def parse_wans(d: dict) -> tuple[WanPort, ...]:
    """Porty WAN bramy z `stat/device`: `port_table` (is_uplink, network_name wan/wan2), `wan1`/`wan2` (up – też
    sprawdzenie internetu) i `uplink` (interfejs, którym idzie teraz ruch). Brak pól = pusta krotka."""
    if str(d.get("type") or "") not in GATEWAY_TYPES:
        return ()
    ports: dict[str, dict] = {}
    for p in d.get("port_table", []):
        if not isinstance(p, dict):
            continue
        network = (_str(p.get("network_name")) or "").lower()
        if not (p.get("is_uplink") or network.startswith("wan")):
            continue
        name = _port_ifname(p)
        if name:
            ports[name] = {"up": bool(p["up"]) if "up" in p else None, "active": bool(p.get("is_uplink")), "slot": _slot(network)}
    for key in sorted(k for k in d if WAN_KEY_RE.match(k)):
        w = d[key]
        name = _str(w.get("ifname")) if isinstance(w, dict) else None
        if not name or w.get("enable") is False:
            continue
        entry = ports.setdefault(name, {"up": None, "active": False, "slot": None})
        entry["slot"] = _slot(key)
        if "up" in w:
            entry["up"] = bool(w["up"])
    uplink = d.get("uplink") if isinstance(d.get("uplink"), dict) else {}
    current = _str(uplink.get("ifname")) or _str(uplink.get("name"))
    if current and (current in ports or IFNAME_RE.match(current)):
        ports.setdefault(current, {"up": bool(uplink["up"]) if "up" in uplink else None, "active": True, "slot": None})
        for name, entry in ports.items():
            entry["active"] = name == current
    return tuple(WanPort(name, e["up"], e["active"], e["slot"]) for name, e in sorted(ports.items()))


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
        links = [
            LldpLink(
                local_port_idx=int(x["local_port_idx"]),
                remote_mac=_str(x["chassis_id"]).lower(),
                remote_ips=tuple(ip for ip in x.get("mgmt_ips") or [] if isinstance(ip, str) and IPV4_RE.match(ip)),
            )
            for x in d.get("lldp_table", [])
            if "local_port_idx" in x and _str(x.get("chassis_id")) and MAC_RE.match(x["chassis_id"].strip())
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
                lldp=links,
                macs=tuple(
                    sorted(
                        {em.lower() for e in d.get("ethernet_table", []) if (em := _str(e.get("mac"))) and MAC_RE.match(em)}
                        | {mac.lower()}
                    )
                ),
                wans=parse_wans(d),
                ports=tuple(
                    PortStats(
                        port_idx=int(p["port_idx"]),
                        name=_str(p.get("name")),
                        up=bool(p["up"]) if "up" in p else None,
                        speed_mbps=_int(p.get("speed")),
                        rx_bytes=_int(p.get("rx_bytes")),
                        tx_bytes=_int(p.get("tx_bytes")),
                        rx_errors=_int(p.get("rx_errors")),
                        tx_errors=_int(p.get("tx_errors")),
                        rx_dropped=_int(p.get("rx_dropped")),
                        tx_dropped=_int(p.get("tx_dropped")),
                    )
                    for p in d.get("port_table", [])
                    if isinstance(p, dict) and _int(p.get("port_idx")) is not None
                ),
            )
        )
    return out


def parse_official_device(raw: dict, stats: dict | None = None) -> OfficialDevice | None:
    """Urządzenie z oficjalnego API: przegląd z listy albo szczegóły (`interfaces` jako obiekt z `ports`/`radios`)
    i opcjonalnie `statistics/latest`. Brak MAC-a albo id = None."""
    mac, dev_id = _str(raw.get("macAddress")), _str(raw.get("id"))
    if not mac or not dev_id or not MAC_RE.match(mac):
        return None
    features = raw.get("features")
    # Lista: features = ["switching", …]; szczegóły: features = {"switching": {...}, …}
    feats = tuple(sorted(features)) if isinstance(features, (list, dict)) else ()
    interfaces = raw.get("interfaces") if isinstance(raw.get("interfaces"), dict) else {}
    ports = []
    for p in interfaces.get("ports") or []:
        idx = _int(p.get("idx")) if isinstance(p, dict) else None
        if idx is None:
            continue
        poe = p.get("poe") if isinstance(p.get("poe"), dict) else {}
        ports.append(
            OfficialPort(
                idx=idx,
                state=_str(p.get("state")) or "UNKNOWN",
                connector=_str(p.get("connector")),
                speed_mbps=_int(p.get("speedMbps")),
                max_speed_mbps=_int(p.get("maxSpeedMbps")),
                poe_enabled=bool(poe["enabled"]) if "enabled" in poe else None,
                poe_state=_str(poe.get("state")),
            )
        )
    radios = tuple(r for r in interfaces.get("radios") or [] if isinstance(r, dict))
    s = stats or {}
    return OfficialDevice(
        id=dev_id,
        mac=mac.lower(),
        ip=_str(raw.get("ipAddress")),
        name=_str(raw.get("name")),
        model=_str(raw.get("model")),
        state=_str(raw.get("state")),
        firmware=_str(raw.get("firmwareVersion")),
        features=feats,
        ports=tuple(sorted(ports, key=lambda p: p.idx)),
        radios=radios,
        uptime_s=_int(s.get("uptimeSec")),
        cpu_percent=_float(s.get("cpuUtilizationPct")),
        mem_percent=_float(s.get("memoryUtilizationPct")),
        load1=_float(s.get("loadAverage1Min")),
        load5=_float(s.get("loadAverage5Min")),
        load15=_float(s.get("loadAverage15Min")),
    )


def parse_official_devices(page: dict) -> list[OfficialDevice]:
    return [d for raw in page.get("data") or [] if isinstance(raw, dict) and (d := parse_official_device(raw))]


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
        self._site_id: str | None = None
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

    async def _paged(self, path: str) -> list[dict]:
        """Wszystkie strony listy oficjalnego API (`offset`, `limit` ≤ 200, `totalCount`)."""
        items: list[dict] = []
        while True:
            sep = "&" if "?" in path else "?"
            page = await self._get(f"{path}{sep}offset={len(items)}&limit=200")
            data = [x for x in page.get("data") or [] if isinstance(x, dict)]
            items += data
            total = _int(page.get("totalCount"))
            if not data or total is None or len(items) >= total or len(items) >= 5000:
                return items

    async def site_id(self) -> str:
        """Identyfikator site w oficjalnym API: ten, którego `internalReference` to nazwa ze starszego API."""
        if self._site_id:
            return self._site_id
        sites = await self._paged("/integration/v1/sites")
        site = next((s for s in sites if s.get("internalReference") == self.site), sites[0] if len(sites) == 1 else None)
        if not site or not _str(site.get("id")):
            raise UnifiError(f"Oficjalne API nie zna site „{self.site}”")
        self._site_id = site["id"]
        return self._site_id

    async def official_devices(self) -> list[OfficialDevice]:
        site = await self.site_id()
        return parse_official_devices({"data": await self._paged(f"/integration/v1/sites/{site}/devices")})

    async def official_details(self, device: OfficialDevice) -> OfficialDevice:
        """Szczegóły (porty, radia) i najnowsze statystyki (CPU, RAM, uptime) jednego urządzenia."""
        site = await self.site_id()
        base = f"/integration/v1/sites/{site}/devices/{device.id}"
        details = await self._get(base)
        try:
            stats = await self._get(base + "/statistics/latest")
        except UnifiError:
            stats = {}  # urządzenie offline albo starsza wersja aplikacji – porty i stan zostają
        return parse_official_device(details, stats) or device

    async def devices(self) -> list[UnifiDevice]:
        return parse_devices(await self._get(f"/api/s/{self.site}/stat/device"))

    async def clients(self) -> list[UnifiClient]:
        return parse_clients(await self._get(f"/api/s/{self.site}/stat/sta"))

    async def close(self) -> None:
        await self._client.aclose()
