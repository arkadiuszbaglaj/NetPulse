"""Sprawdzenie DNS (od 0.64.0): klient dnsquery.py kontra atrapa serwera DNS na localhost (UDP i TCP)."""

from __future__ import annotations

import asyncio
import ipaddress
import struct

import pytest

from netpulse import checks, dnsquery
from netpulse.api.checks import CheckIn


def _name(n: str) -> bytes:
    return b"".join(bytes([len(p)]) + p.encode() for p in n.split(".")) + b"\x00"


def response(query: bytes, records: list[tuple[int, bytes]], rcode: int = 0, truncated: bool = False) -> bytes:
    """Odpowiedź na zapytanie: pytanie skopiowane, rekordy z nazwą przez wskaźnik kompresji (0xC00C)."""
    qid = struct.unpack(">H", query[:2])[0]
    question = query[12:]
    flags = 0x8180 | rcode | (0x0200 if truncated else 0)
    out = struct.pack(">HHHHHH", qid, flags, 1, len(records), 0, 0) + question
    for rtype, rdata in records:
        out += b"\xc0\x0c" + struct.pack(">HHIH", rtype, 1, 300, len(rdata)) + rdata
    return out


def qname(query: bytes) -> tuple[str, int]:
    name, pos = dnsquery._read_name(query, 12)
    return name, struct.unpack(">H", query[pos : pos + 2])[0]


ZONE: dict[tuple[str, int], list[tuple[int, bytes]]] = {
    ("nas.lan", 1): [(1, ipaddress.IPv4Address("192.168.1.34").packed)],
    ("nas.lan", 28): [(28, ipaddress.IPv6Address("fd00::34").packed)],
    ("example.com", 15): [(15, struct.pack(">H", 10) + _name("mail.example.com"))],
    ("example.com", 16): [(16, b"\x0cv=spf1 -all,"), (16, b"\x05ab,cd")],
    ("www.example.com", 1): [(5, _name("example.com")), (1, ipaddress.IPv4Address("192.0.2.10").packed)],
    ("example.com", 1): [],
}


class FakeDns(asyncio.DatagramProtocol):
    def __init__(self, big: bool = False):
        self.big = big
        self.queries = 0

    def connection_made(self, transport):
        self.transport = transport

    def datagram_received(self, data, addr):
        self.queries += 1
        name, rtype = qname(data)
        if name == "big.example.com":
            self.transport.sendto(response(data, [], truncated=True), addr)
        elif (name, rtype) in ZONE:
            self.transport.sendto(response(data, ZONE[(name, rtype)]), addr)
        elif name == "broken.example.com":
            self.transport.sendto(response(data, [], rcode=2), addr)
        elif name == "silent.example.com":
            pass
        else:
            self.transport.sendto(response(data, [], rcode=3), addr)


async def _tcp_handler(reader, writer):
    size = struct.unpack(">H", await reader.readexactly(2))[0]
    data = await reader.readexactly(size)
    recs = [(1, ipaddress.IPv4Address(f"198.51.100.{i}").packed) for i in range(1, 4)]
    resp = response(data, recs)
    writer.write(struct.pack(">H", len(resp)) + resp)
    await writer.drain()
    writer.close()


async def with_server(fn):
    loop = asyncio.get_running_loop()
    transport, proto = await loop.create_datagram_endpoint(FakeDns, local_addr=("127.0.0.1", 0))
    port = transport.get_extra_info("sockname")[1]
    tcp = await asyncio.start_server(_tcp_handler, "127.0.0.1", port)
    try:
        return await fn(port, proto)
    finally:
        transport.close()
        tcp.close()


def run(fn):
    return asyncio.run(with_server(fn))


def test_records_of_each_type():
    async def go(port, _):
        q = lambda name, t: dnsquery.query(name, t, server="127.0.0.1", port=port, timeout=2)  # noqa: E731
        a = await q("nas.lan", "A")
        assert a.rcode == "NOERROR" and a.answers == ["192.168.1.34"] and a.latency_ms >= 0
        assert (await q("nas.lan", "AAAA")).answers == ["fd00::34"]
        assert (await q("example.com", "MX")).answers == ["10 mail.example.com"]
        assert (await q("example.com", "TXT")).answers == ["v=spf1 -all,", "ab,cd"]
        assert (await q("www.example.com", "A")).answers == ["CNAME example.com", "192.0.2.10"]
        assert (await q("nie-ma.example.com", "A")).rcode == "NXDOMAIN"

    run(go)


def test_truncated_answer_falls_back_to_tcp():
    async def go(port, _):
        res = await dnsquery.query("big.example.com", "A", server="127.0.0.1", port=port, timeout=2)
        assert res.answers == ["198.51.100.1", "198.51.100.2", "198.51.100.3"]

    run(go)


def test_dns_check_verdicts():
    async def go(port, _):
        def c(name, t="A", expected=None, timeout=2.0):
            return checks.run_check("dns", name, port=port, timeout=timeout, keyword=expected, dns_type=t, dns_server="127.0.0.1")

        ok = await c("nas.lan", expected="192.168.1.34")
        assert ok.up and ok.answer == "192.168.1.34" and ok.error is None
        wrong = await c("nas.lan", expected="192.168.1.3")  # 192.168.1.3 ≠ 192.168.1.34
        assert not wrong.up and "192.168.1.3" in wrong.error and wrong.answer == "192.168.1.34"
        assert (await c("example.com", "MX", expected="mail.example.com.")).up
        assert (await c("example.com", "TXT", expected="v=spf1")).up
        nx = await c("nie-ma.example.com")
        assert not nx.up and nx.error.startswith("NXDOMAIN")
        assert (await c("broken.example.com")).error.startswith("SERVFAIL")
        empty = await c("example.com")
        assert not empty.up and empty.error == "Brak rekordu A dla example.com"
        silent = await c("silent.example.com", timeout=0.3)
        assert not silent.up and "nie odpowiedział" in silent.error

    run(go)


def test_missing_expected_rules():
    assert dnsquery.missing_expected(["192.168.1.34"], "192.168.1.34, 10.0.0.1") == ["10.0.0.1"]
    assert dnsquery.missing_expected(["10 Mail.Example.com"], "mail.example.com") == []
    assert dnsquery.missing_expected(['v=spf1 include:_spf.google.com ~all'], "include:_spf.google.com", "TXT") == []
    assert dnsquery.missing_expected(["a"], None) == []


def test_system_server_from_resolv_conf(tmp_path):
    f = tmp_path / "resolv.conf"
    f.write_text("# docker\nsearch lan\nnameserver 127.0.0.11\nnameserver 8.8.8.8\n")
    assert dnsquery.system_server(f) == "127.0.0.11"
    assert dnsquery.system_server(tmp_path / "brak") == dnsquery.DEFAULT_SERVER


def test_bad_name_is_error():
    with pytest.raises(dnsquery.DnsError):
        dnsquery.encode_name("a..b")


def test_api_validation():
    c = CheckIn(name="DNS", kind="dns", target="Example.com.", dns_server=" 1.1.1.1 ", keyword="", interval_s=60)
    assert c.target == "Example.com" and c.dns_type == "A" and c.dns_server == "1.1.1.1" and c.keyword is None
    with pytest.raises(ValueError):
        CheckIn(name="DNS", kind="dns", target="zła nazwa")
    with pytest.raises(ValueError):
        CheckIn(name="DNS", kind="dns", target="example.com", dns_server="zły serwer")
    with pytest.raises(ValueError):
        CheckIn(name="DNS", kind="dns", target="example.com", dns_type="SRV")
    ping = CheckIn(name="P", kind="ping", target="8.8.8.8", dns_type="MX", dns_server="1.1.1.1")
    assert ping.dns_type is None and ping.dns_server is None
