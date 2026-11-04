"""VPN użytkowników zdalnych (od 0.57.0, moduł UniFi; opis: docs/30-vpn.md).

- GET /api/vpn – serwery VPN i klienci: kto jest połączony, od kiedy, skąd, ile przesłał, bieżący ruch; rozłączeni
  z czasem ostatniego połączenia. Dane z ostatniego odczytu kontrolera (`netpulse/vpn.py`), `stale` = odczyt starszy niż
  `STALE` (kontroler nie odpowiada) – wtedy nie wiadomo, kto jest połączony.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from .. import vpn as vpn_state
from ..db import Session
from ..modules import is_enabled
from .security import require_user

router = APIRouter(prefix="/api", tags=["VPN"], dependencies=[Depends(require_user)])

STALE = timedelta(minutes=3)


class VpnServerOut(BaseModel):
    id: str
    name: str
    type: str
    enabled: bool
    port: int | None = None
    subnet: str | None = None


class VpnUserOut(BaseModel):
    name: str
    server: str | None = None  # nazwa serwera VPN
    tunnel_ip: str | None = None
    connected: bool
    since: datetime | None = None  # początek trwającego połączenia
    last_seen: datetime | None = None  # ostatni odczyt, w którym był połączony
    remote_ip: str | None = None  # skąd się łączy (adres publiczny) – nie na pulpicie publicznym
    down_bytes: float | None = None  # przesłane do klienta w ostatnim połączeniu
    up_bytes: float | None = None
    down_bps: float | None = None  # bieżący ruch do klienta (jego pobieranie)
    up_bps: float | None = None


class VpnOut(BaseModel):
    at: datetime | None = None
    stale: bool = False
    device_id: int | None = None  # brama, na której działa VPN (źródło wykresów `vpn`)
    servers: list[VpnServerOut] = []
    users: list[VpnUserOut] = []


async def status(public: bool = False) -> VpnOut:
    if not await is_enabled("unifi"):
        return VpnOut()
    async with Session() as session:
        snaps = await vpn_state.read_all(session)
    out = VpnOut()
    for snap in snaps:
        at = datetime.fromisoformat(snap["at"])
        out.at = max(out.at, at) if out.at else at
        out.device_id = out.device_id or snap.get("device_id")
        names = {s["id"]: s["name"] for s in snap.get("servers", [])}
        out.servers += [VpnServerOut(**s) for s in snap.get("servers", [])]
        stale = datetime.now(UTC) - at > STALE
        for u in snap.get("users", []):
            user = VpnUserOut(**{k: v for k, v in u.items() if k != "server_id"}, server=names.get(u.get("server_id")))
            if stale:
                user = user.model_copy(update={"connected": False, "since": None, "down_bps": None, "up_bps": None})
            if public:
                user = user.model_copy(update={"remote_ip": None, "tunnel_ip": None})
            out.users.append(user)
    out.stale = out.at is not None and datetime.now(UTC) - out.at > STALE
    # Połączeni na górze (najdłużej połączony pierwszy), potem rozłączeni od ostatnio widzianego
    epoch = datetime.min.replace(tzinfo=UTC)
    out.users.sort(key=lambda u: (not u.connected, u.since or epoch if u.connected else -(u.last_seen or epoch).timestamp(), u.name))
    return out


@router.get("/vpn", response_model=VpnOut)
async def vpn() -> VpnOut:
    return await status()
