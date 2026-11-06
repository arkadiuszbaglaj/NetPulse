"""Minimalny klient DNS do sprawdzeń dostępności (od 0.64.0) – bez zewnętrznej biblioteki.

Jedno zapytanie (RFC 1035) przez UDP do wskazanego serwera albo pierwszego `nameserver` z /etc/resolv.conf
(w kontenerze: DNS Dockera, który pyta serwery hosta); gdy odpowiedź jest obcięta (TC), to samo przez TCP.
Typy: A, AAAA, CNAME, MX, TXT, NS, PTR. Wynik: kod odpowiedzi (NOERROR, NXDOMAIN…), czas i odpowiedzi tekstem
(`192.0.2.1`, `10 mail.example.com`, `"v=spf1 …"`), w kolejności z serwera.
"""

from __future__ import annotations

import asyncio
import ipaddress
import secrets
import struct
import time
from dataclasses import dataclass, field
from pathlib import Path

TYPES = {"A": 1, "NS": 2, "CNAME": 5, "PTR": 12, "MX": 15, "TXT": 16, "AAAA": 28}
_TYPE_NAMES = {v: k for k, v in TYPES.items()}
RCODES = {0: "NOERROR", 1: "FORMERR", 2: "SERVFAIL", 3: "NXDOMAIN", 4: "NOTIMP", 5: "REFUSED"}
RESOLV_CONF = Path("/etc/resolv.conf")
DEFAULT_SERVER = "127.0.0.53"


class DnsError(Exception):
    pass


@dataclass
class DnsAnswer:
    rcode: str
    latency_ms: float
    answers: list[str] = field(default_factory=list)
    server: str = ""


def system_server(path: Path = RESOLV_CONF) -> str:
    try:
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            parts = line.split()
            if len(parts) >= 2 and parts[0] == "nameserver":
                return parts[1].split("%", 1)[0]
    except OSError:
        pass
    return DEFAULT_SERVER


def encode_name(name: str) -> bytes:
    out = b""
    for label in name.strip().rstrip(".").split("."):
        raw = label.encode("idna") if label else b""
        if not raw or len(raw) > 63:
            raise DnsError(f"Niepoprawna nazwa: {name}")
        out += bytes([len(raw)]) + raw
    return out + b"\x00"


def build_query(name: str, rtype: str, qid: int) -> bytes:
    # nagłówek: id, flagi RD=1, 1 pytanie
    return struct.pack(">HHHHHH", qid, 0x0100, 1, 0, 0, 0) + encode_name(name) + struct.pack(">HH", TYPES[rtype], 1)


def _read_name(msg: bytes, pos: int) -> tuple[str, int]:
    labels: list[str] = []
    end = None
    jumps = 0
    while True:
        if pos >= len(msg):
            raise DnsError("Uszkodzona odpowiedź DNS")
        length = msg[pos]
        if length & 0xC0 == 0xC0:  # wskaźnik kompresji
            if pos + 1 >= len(msg):
                raise DnsError("Uszkodzona odpowiedź DNS")
            if end is None:
                end = pos + 2
            pos = ((length & 0x3F) << 8) | msg[pos + 1]
            jumps += 1
            if jumps > 32:
                raise DnsError("Pętla w odpowiedzi DNS")
            continue
        if length == 0:
            pos += 1
            break
        labels.append(msg[pos + 1 : pos + 1 + length].decode("ascii", errors="replace"))
        pos += 1 + length
    return ".".join(labels), end if end is not None else pos


def _rdata(msg: bytes, rtype: int, start: int, length: int) -> str | None:
    data = msg[start : start + length]
    if rtype == 1 and length == 4:
        return str(ipaddress.IPv4Address(data))
    if rtype == 28 and length == 16:
        return str(ipaddress.IPv6Address(data))
    if rtype in (2, 5, 12):
        return _read_name(msg, start)[0]
    if rtype == 15 and length >= 3:
        pref = struct.unpack(">H", data[:2])[0]
        return f"{pref} {_read_name(msg, start + 2)[0]}"
    if rtype == 16:
        parts, i = [], 0
        while i < len(data):
            n = data[i]
            parts.append(data[i + 1 : i + 1 + n].decode("utf-8", errors="replace"))
            i += 1 + n
        return "".join(parts)
    return None


def parse_response(msg: bytes, qid: int, rtype: str) -> tuple[str, list[str], bool]:
    """Zwraca (kod odpowiedzi, odpowiedzi danego typu i CNAME po drodze, czy obcięta)."""
    if len(msg) < 12:
        raise DnsError("Za krótka odpowiedź DNS")
    rid, flags, qd, an, _ns, _ar = struct.unpack(">HHHHHH", msg[:12])
    if rid != qid:
        raise DnsError("Odpowiedź na inne zapytanie")
    truncated = bool(flags & 0x0200)
    rcode = RCODES.get(flags & 0x000F, f"RCODE{flags & 0x000F}")
    pos = 12
    for _ in range(qd):
        _, pos = _read_name(msg, pos)
        pos += 4
    answers: list[str] = []
    want = TYPES[rtype]
    for _ in range(an):
        _, pos = _read_name(msg, pos)
        if pos + 10 > len(msg):
            raise DnsError("Uszkodzona odpowiedź DNS")
        atype, _cls, _ttl, rdlen = struct.unpack(">HHIH", msg[pos : pos + 10])
        pos += 10
        if atype == want or (atype == 5 and want != 5):
            value = _rdata(msg, atype, pos, rdlen)
            if value is not None:
                answers.append(value if atype == want else f"CNAME {value}")
        pos += rdlen
    return rcode, answers, truncated


class _Udp(asyncio.DatagramProtocol):
    def __init__(self) -> None:
        self.future: asyncio.Future[bytes] = asyncio.get_running_loop().create_future()

    def datagram_received(self, data: bytes, addr) -> None:
        if not self.future.done():
            self.future.set_result(data)

    def error_received(self, exc: Exception) -> None:
        if not self.future.done():
            self.future.set_exception(exc)


async def _udp(server: str, port: int, query: bytes, timeout: float) -> bytes:
    loop = asyncio.get_running_loop()
    transport, proto = await loop.create_datagram_endpoint(_Udp, remote_addr=(server, port))
    try:
        transport.sendto(query)
        return await asyncio.wait_for(proto.future, timeout)
    finally:
        transport.close()


async def _tcp(server: str, port: int, query: bytes, timeout: float) -> bytes:
    reader, writer = await asyncio.wait_for(asyncio.open_connection(server, port), timeout)
    try:
        writer.write(struct.pack(">H", len(query)) + query)
        await writer.drain()
        size = struct.unpack(">H", await asyncio.wait_for(reader.readexactly(2), timeout))[0]
        return await asyncio.wait_for(reader.readexactly(size), timeout)
    finally:
        writer.close()


async def query(name: str, rtype: str = "A", server: str | None = None, port: int = 53, timeout: float = 5.0) -> DnsAnswer:
    """Rzuca DnsError, TimeoutError albo OSError; wynik (także NXDOMAIN) jako DnsAnswer."""
    rtype = rtype.upper()
    if rtype not in TYPES:
        raise DnsError(f"Nieobsługiwany typ rekordu: {rtype}")
    server = server or system_server()
    qid = secrets.randbelow(0x10000)
    q = build_query(name, rtype, qid)
    started = time.perf_counter()
    msg = await _udp(server, port, q, timeout)
    rcode, answers, truncated = parse_response(msg, qid, rtype)
    if truncated:
        msg = await _tcp(server, port, q, timeout)
        rcode, answers, _ = parse_response(msg, qid, rtype)
    return DnsAnswer(rcode=rcode, latency_ms=round((time.perf_counter() - started) * 1000.0, 2), answers=answers, server=server)


def _norm(value: str) -> str:
    return value.strip().strip('"').rstrip(".").lower()


def missing_expected(answers: list[str], expected: str | None, rtype: str = "A") -> list[str]:
    """Oczekiwane wartości (po przecinku), których nie ma w odpowiedzi; pusta lista = zgodna odpowiedź.

    Porównanie bez wielkości liter i końcowej kropki (adresy IP – dokładnie, także 192.168.1.3 ≠ 192.168.1.34);
    dla MX wystarczy sama nazwa serwera, dla TXT – fragment tekstu (np. `v=spf1`)."""
    if not expected:
        return []
    have = [_norm(a) for a in answers]
    txt = rtype.upper() == "TXT"
    separator = ";" if txt else ","  # w TXT bywają przecinki
    out = []
    for want in (w for w in (x.strip() for x in expected.split(separator)) if w):
        w = _norm(want)
        if not any(h == w or h.endswith(" " + w) or (txt and w in h) for h in have):
            out.append(want)
    return out
