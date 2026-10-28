"""Sprawdzanie dostępności bez bazy: wyniki pingu, kody HTTP, port TCP, walidacja formularza."""

from __future__ import annotations

import asyncio
import socket
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from pydantic import ValidationError

from netpulse import checks
from netpulse.api.checks import CheckIn


def run(coro):
    return asyncio.run(coro)


def test_ping_summary_latency_loss_jitter():
    r = checks.ping_summary([10.0, 12.0, 11.0, 15.0], sent=5)
    assert r.up and r.latency_ms == 12.0 and r.loss_percent == 20.0
    assert r.jitter_ms == pytest.approx((2 + 1 + 4) / 3, abs=0.01)
    lost = checks.ping_summary([], sent=5)
    assert not lost.up and lost.loss_percent == 100.0 and lost.latency_ms is None and "odpowiedzi" in lost.error
    assert checks.jitter([5.0]) is None


def test_echo_packets():
    req = checks.echo_request(seq=513, v6=False)
    assert req[0] == 8 and int.from_bytes(req[6:8], "big") == 513 and len(req) == 16
    assert checks.echo_request(1, v6=True)[0] == 128
    reply = bytes([0, 0, 0, 0, 0x12, 0x34]) + (513).to_bytes(2, "big") + b"payload!"
    assert checks.parse_echo_reply(reply, v6=False) == 513
    assert checks.parse_echo_reply(bytes([129]) + reply[1:], v6=True) == 513
    assert checks.parse_echo_reply(bytes([3]) + reply[1:], v6=False) is None  # „host nieosiągalny”, nie echo
    assert checks.parse_echo_reply(b"\x00\x00", v6=False) is None


def test_expected_status_rules():
    assert checks.status_ok(200, None) and checks.status_ok(301, None) and not checks.status_ok(404, None)
    assert checks.status_ok(204, "200,204") and not checks.status_ok(201, "200,204")
    assert checks.status_ok(503, "5xx") and checks.status_ok(401, "200-299, 401")
    assert checks.valid_expect("200-399") and checks.valid_expect("2xx,404") and not checks.valid_expect("ok") and not checks.valid_expect("20x-")


def test_cert_days_left():
    now = datetime(2026, 10, 28, tzinfo=UTC)
    assert checks.cert_days_left(now + timedelta(days=30, hours=12), now) == 30.5
    assert checks.cert_days_left(now - timedelta(days=2), now) == -2.0


def mock(handler):
    return httpx.MockTransport(handler)


def test_http_check_status_and_keyword():
    page = mock(lambda req: httpx.Response(200, text="<h1>Pi-hole działa</h1>"))
    ok = run(checks.http_check("http://pihole.lan/admin", keyword="Pi-hole", transport=page))
    assert ok.up and ok.status_code == 200 and ok.latency_ms is not None and ok.cert_days is None
    missing = run(checks.http_check("http://pihole.lan/admin", keyword="Home Assistant", transport=page))
    assert not missing.up and "Home Assistant" in missing.error
    broken = run(checks.http_check("http://nas.lan", transport=mock(lambda req: httpx.Response(502))))
    assert not broken.up and broken.status_code == 502 and "502" in broken.error
    custom = run(checks.http_check("http://api.lan", expect="401", transport=mock(lambda req: httpx.Response(401))))
    assert custom.up


def test_http_check_connection_errors():
    def refuse(req):
        raise httpx.ConnectError("Connection refused", request=req)

    def slow(req):
        raise httpx.ReadTimeout("timeout", request=req)

    assert run(checks.http_check("http://nas.lan", transport=mock(refuse))).error == "Connection refused"
    timeout = run(checks.http_check("http://nas.lan", timeout=2, transport=mock(slow)))
    assert not timeout.up and "2 s" in timeout.error


def test_tcp_check_open_and_closed_port():
    async def go():
        server = await asyncio.start_server(lambda r, w: w.close(), "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]
        try:
            opened = await checks.tcp_check("127.0.0.1", port, timeout=2)
        finally:
            server.close()
            await server.wait_closed()
        closed = await checks.tcp_check("127.0.0.1", port, timeout=2)
        return port, opened, closed

    port, opened, closed = run(go())
    assert opened.up and opened.latency_ms is not None
    assert not closed.up and str(port) in closed.error  # odmowa (Linux) albo limit czasu (Windows)


def test_run_check_never_raises():
    assert not run(checks.run_check("dns", "x")).up
    assert not run(checks.run_check("tcp", "127.0.0.1", port=None)).up


def test_check_form_validation():
    ping = CheckIn(name=" Internet ", kind="ping", target=" 8.8.8.8 ", port=80, expect_status="200", keyword="x")
    assert (ping.name, ping.target, ping.port, ping.expect_status, ping.keyword) == ("Internet", "8.8.8.8", None, None, None)
    http = CheckIn(name="WWW", kind="http", target="https://example.com/health", port=443, expect_status=" 2xx ", interval_s=60, timeout_s=10)
    assert http.port is None and http.expect_status == "2xx"
    assert CheckIn(name="SSH", kind="tcp", target="nas.lan", port=22).port == 22
    bad = [
        dict(name="x", kind="http", target="ftp://example.com"),
        dict(name="x", kind="http", target="https://example.com", expect_status="ok"),
        dict(name="x", kind="tcp", target="nas.lan"),  # brak portu
        dict(name="x", kind="ping", target="nie host!"),
        dict(name="x", kind="ping", target="8.8.8.8", interval_s=30, timeout_s=30),  # limit ≥ odstęp
        dict(name="x", kind="ping", target="8.8.8.8", interval_s=5),
        dict(name="", kind="ping", target="8.8.8.8"),
    ]
    for body in bad:
        with pytest.raises(ValidationError):
            CheckIn(**body)


@pytest.mark.skipif(not hasattr(socket, "AF_UNIX"), reason="potrzebne gniazda uniksowe (Linux w CI)")
def test_ping_works_on_loop_without_sock_sendto(monkeypatch):
    """API działa na uvloop, który nie ma loop.sock_sendto/sock_recv – ping nie może z nich korzystać (0.30.1)."""
    ours, theirs = socket.socketpair(socket.AF_UNIX, socket.SOCK_DGRAM)

    class FakeIcmp:
        """Gniazdo ICMP udawane parą gniazd: każde echo request od razu dostaje echo reply (typ 0)."""

        def __init__(self, *args):
            pass

        def setblocking(self, flag):
            ours.setblocking(flag)

        def fileno(self):
            return ours.fileno()

        def sendto(self, data, addr):
            theirs.send(bytes([0]) + data[1:])
            return len(data)

        def recv(self, size):
            return ours.recv(size)

        def close(self):
            ours.close()
            theirs.close()

    class UvloopLike(asyncio.SelectorEventLoop):
        async def sock_sendto(self, *args):
            raise NotImplementedError

        async def sock_recv(self, *args):
            raise NotImplementedError

    async def resolve(host, port=None):
        return socket.AF_INET, "192.0.2.1"

    loop = UvloopLike()  # przed podmianą socket.socket – pętla sama tworzy gniazda
    monkeypatch.setattr(checks, "_resolve", resolve)
    monkeypatch.setattr(checks.socket, "socket", FakeIcmp)
    try:
        r = loop.run_until_complete(checks.ping("example", timeout=2, count=3, gap=0.01))
    finally:
        monkeypatch.undo()
        loop.close()
    assert r.up and r.loss_percent == 0.0 and r.latency_ms is not None, r
