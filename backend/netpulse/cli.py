"""Linia poleceń NetPulse.

    netpulse probe 192.168.1.1 --community public   # test urządzenia bez zapisu
    netpulse device add "UCG Ultra" 192.168.1.1     # dodanie urządzenia
    netpulse device list
    netpulse device remove 3
    netpulse db init
    netpulse collector                               # usługa kolektora
    netpulse api                                     # usługa API
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys

from . import __version__
from .config import settings
from .snmp import SnmpCredentials


def _fmt_bytes(n: int | None) -> str:
    if n is None:
        return "-"
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if abs(n) < 1024:
            return f"{n:.0f} {unit}"
        n /= 1024  # type: ignore[assignment]
    return f"{n:.1f} PB"


def _fmt_uptime(s: float | None) -> str:
    if s is None:
        return "-"
    d, rem = divmod(int(s), 86400)
    h, rem = divmod(rem, 3600)
    return f"{d}d {h}h {rem // 60}m"


def _creds(args: argparse.Namespace) -> SnmpCredentials:
    return SnmpCredentials(
        version=args.snmp_version,
        community=args.community,
        username=args.v3_user,
        auth_protocol=args.v3_auth_proto,
        auth_key=args.v3_auth_key,
        priv_protocol=args.v3_priv_proto,
        priv_key=args.v3_priv_key,
        context_name=args.v3_context or "",
    )


def _add_snmp_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("--port", type=int, default=161)
    p.add_argument("--snmp-version", choices=["1", "2c", "3"], default="2c")
    p.add_argument("--community", default="public")
    p.add_argument("--driver", default="auto", help="auto | generic | unifi")
    p.add_argument("--v3-user")
    p.add_argument("--v3-auth-proto", choices=["MD5", "SHA", "SHA224", "SHA256", "SHA384", "SHA512"])
    p.add_argument("--v3-auth-key")
    p.add_argument("--v3-priv-proto", choices=["DES", "AES", "AES192", "AES256"])
    p.add_argument("--v3-priv-key")
    p.add_argument("--v3-context")


async def _probe(host: str, port: int, creds: SnmpCredentials, driver: str):
    from .drivers import poll_device
    from .snmp.client import PySnmpClient

    client = PySnmpClient(host, creds, port=port, timeout=settings.snmp_timeout, retries=settings.snmp_retries)
    try:
        return await poll_device(client, driver)
    finally:
        await client.close()


def print_result(result, show_hidden: bool = False) -> None:
    s = result.system
    print(f"\n  {s.name or '?'}  ({s.vendor} {s.model or ''}, firmware {s.firmware or '-'})")
    print(f"  typ: {s.kind}   driver: {result.driver}   uptime: {_fmt_uptime(s.uptime_s)}")
    h = result.health
    if h.mem_total_kb:
        print(
            f"  CPU: {h.cpu_percent if h.cpu_percent is not None else '-'}%   "
            f"RAM: {h.mem_used_percent}% z {_fmt_bytes(h.mem_total_kb * 1024)}   load: {h.load1}"
        )
    print(f"\n  {'#':>3}  {'Port':<10} {'Interfejs':<10} {'Rola':<8} {'Status':<6} {'Prędkość':>9}  "
          f"{'Odebrano':>10} {'Wysłano':>10}  Opis")
    for i in result.interfaces:
        if i.hidden and not show_hidden:
            continue
        speed = f"{i.speed_mbps} Mb/s" if i.speed_mbps else "-"
        print(
            f"  {i.if_index:>3}  {i.label:<10} {i.name:<10} {i.role:<8} {i.oper_status:<6} {speed:>9}  "
            f"{_fmt_bytes(i.in_octets):>10} {_fmt_bytes(i.out_octets):>10}  {i.alias or ''}"
        )
    hidden = [i.name for i in result.interfaces if i.hidden]
    if hidden and not show_hidden:
        print(f"  (ukryte interfejsy techniczne: {len(hidden)} – pokaż: --all)")
    wifi = [w for w in result.wifi if show_hidden or not w.hidden]
    if wifi:
        print(f"\n  {'SSID':<24} {'Pasmo':<7} {'Kanał':>5} {'Klienci':>7}")
        for w in wifi:
            print(f"  {w.ssid:<24} {w.radio or '-':<7} {w.channel or '-':>5} {w.clients or 0:>7}")
    print()


def cmd_probe(args) -> int:
    from .snmp import SnmpError

    try:
        result = asyncio.run(_probe(args.host, args.port, _creds(args), args.driver))
    except SnmpError as exc:
        print(f"Błąd SNMP: {exc}", file=sys.stderr)
        return 2
    print_result(result, args.all)
    return 0


def cmd_device_add(args) -> int:
    from sqlalchemy import select

    from .db import Session, init_db
    from .db.models import Device
    from .snmp import SnmpError

    creds = _creds(args)
    if not args.no_probe:
        print(f"Sprawdzam {args.host} ...")
        try:
            result = asyncio.run(_probe(args.host, args.port, creds, args.driver))
            print(f"OK: {result.system.vendor} {result.system.model} ({result.system.kind}), "
                  f"{len(result.visible_interfaces())} portów")
        except SnmpError as exc:
            print(f"Błąd SNMP: {exc}\nUrządzenie nie zostało dodane (pomiń test: --no-probe).", file=sys.stderr)
            return 2

    async def add() -> int:
        await init_db()
        async with Session() as session, session.begin():
            existing = await session.scalar(select(Device).where(Device.host == args.host))
            if existing:
                print(f"Urządzenie {args.host} już istnieje (id={existing.id}).", file=sys.stderr)
                return 1
            device = Device(
                name=args.name,
                host=args.host,
                port=args.port,
                driver=args.driver,
                snmp_version=args.snmp_version,
                community=args.community if args.snmp_version != "3" else None,
                v3_username=args.v3_user,
                v3_auth_protocol=args.v3_auth_proto,
                v3_auth_key=args.v3_auth_key,
                v3_priv_protocol=args.v3_priv_proto,
                v3_priv_key=args.v3_priv_key,
                v3_context=args.v3_context,
            )
            session.add(device)
            await session.flush()
            print(f"Dodano urządzenie id={device.id}: {device.name} ({device.host}). "
                  f"Kolektor odpyta je w ciągu {settings.poll_interval} s.")
        return 0

    return asyncio.run(add())


def cmd_device_list(args) -> int:
    from sqlalchemy import select

    from .db import Session
    from .db.models import Device

    async def run() -> int:
        async with Session() as session:
            devices = (await session.scalars(select(Device).order_by(Device.id))).all()
        if not devices:
            print("Brak urządzeń. Dodaj: netpulse device add NAZWA IP --community public")
            return 0
        print(f"  {'id':>3}  {'Nazwa':<20} {'Adres':<16} {'Typ':<8} {'Model':<14} {'Status':<7} Ostatni odczyt")
        for d in devices:
            last = d.last_polled_at.strftime("%Y-%m-%d %H:%M:%S") if d.last_polled_at else "-"
            print(f"  {d.id:>3}  {d.name:<20} {d.host:<16} {d.kind:<8} {d.model or '-':<14} {d.status:<7} {last}")
            if d.last_error:
                print(f"       błąd: {d.last_error}")
        return 0

    return asyncio.run(run())


def cmd_device_remove(args) -> int:
    from .db import Session
    from .db.models import Device

    async def run() -> int:
        async with Session() as session, session.begin():
            device = await session.get(Device, args.id)
            if not device:
                print(f"Nie ma urządzenia id={args.id}", file=sys.stderr)
                return 1
            await session.delete(device)
            print(f"Usunięto {device.name} ({device.host}) razem z historią metryk.")
        return 0

    return asyncio.run(run())


def cmd_db_init(args) -> int:
    from .db import init_db

    timescale = asyncio.run(init_db())
    print(f"Baza gotowa (TimescaleDB: {'tak' if timescale else 'nie'}).")
    return 0


def cmd_collector(args) -> int:
    from .collector import run

    asyncio.run(run())
    return 0


def cmd_api(args) -> int:
    import uvicorn

    uvicorn.run("netpulse.api:app", host=settings.api_host, port=settings.api_port, proxy_headers=True)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="netpulse", description="NetPulse – monitoring sieci")
    parser.add_argument("--version", action="version", version=f"NetPulse {__version__}")
    parser.add_argument("-v", "--verbose", action="store_true")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("probe", help="odpytaj urządzenie i pokaż wynik (bez zapisu)")
    p.add_argument("host")
    p.add_argument("--all", action="store_true", help="pokaż też ukryte interfejsy")
    _add_snmp_args(p)
    p.set_defaults(func=cmd_probe)

    dev = sub.add_parser("device", help="zarządzanie urządzeniami").add_subparsers(dest="action", required=True)
    p = dev.add_parser("add", help="dodaj urządzenie")
    p.add_argument("name")
    p.add_argument("host")
    p.add_argument("--no-probe", action="store_true", help="nie testuj połączenia przed dodaniem")
    _add_snmp_args(p)
    p.set_defaults(func=cmd_device_add)
    p = dev.add_parser("list", help="lista urządzeń")
    p.set_defaults(func=cmd_device_list)
    p = dev.add_parser("remove", help="usuń urządzenie")
    p.add_argument("id", type=int)
    p.set_defaults(func=cmd_device_remove)

    db = sub.add_parser("db", help="baza danych").add_subparsers(dest="action", required=True)
    db.add_parser("init", help="utwórz/uzupełnij schemat").set_defaults(func=cmd_db_init)

    sub.add_parser("collector", help="uruchom kolektor").set_defaults(func=cmd_collector)
    sub.add_parser("api", help="uruchom API").set_defaults(func=cmd_api)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    level = logging.DEBUG if args.verbose else getattr(logging, settings.log_level.upper(), logging.INFO)
    logging.basicConfig(level=level, format="%(asctime)s %(levelname)-7s %(name)s: %(message)s")
    logging.getLogger("pysnmp").setLevel(logging.WARNING)
    return args.func(args) or 0


if __name__ == "__main__":
    sys.exit(main())
