"""Sprawdzanie dostępności (od 0.30.0): ping, HTTP(S) i port TCP.

- Ping: gniazdo ICMP bez uprawnień roota (`SOCK_DGRAM` + `IPPROTO_ICMP`, Linux; Docker domyślnie pozwala na nie
  wszystkim grupom – `net.ipv4.ping_group_range`). Seria `PING_COUNT` pakietów co `PING_GAP_S`: średnie opóźnienie,
  utrata pakietów w % i jitter (średnia różnica kolejnych opóźnień). Jądro samo liczy sumę kontrolną i ustawia
  identyfikator, więc odpowiedzi rozpoznajemy po numerze sekwencji.
- HTTP(S): `GET` z przekierowaniami, oczekiwany kod (domyślnie 200–399), opcjonalnie tekst w treści;
  dla https osobnym połączeniem TLS – dni do wygaśnięcia certyfikatu (także gdy weryfikacja jest wyłączona).
- TCP: czas nawiązania połączenia.

Funkcje nie rzucają wyjątków – błąd to wynik `up=False` z opisem w `error`.
"""

from __future__ import annotations

import asyncio
import os
import socket
import ssl
import struct
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from urllib.parse import urlsplit

import httpx

PING_COUNT = 5
PING_GAP_S = 0.2
MAX_BODY = 1_000_000  # słowo kluczowe szukamy w pierwszym megabajcie odpowiedzi
USER_AGENT = "NetPulse-check"


@dataclass
class CheckResult:
    up: bool
    latency_ms: float | None = None
    loss_percent: float | None = None
    jitter_ms: float | None = None
    status_code: int | None = None
    cert_days: float | None = None
    error: str | None = None


def _err(exc: BaseException) -> str:
    text = str(exc) or type(exc).__name__
    return text[:250]


def jitter(rtts: list[float]) -> float | None:
    """Średnia bezwzględna różnica kolejnych opóźnień (jak w RFC 3550, bez wygładzania)."""
    if len(rtts) < 2:
        return None
    return sum(abs(b - a) for a, b in zip(rtts, rtts[1:], strict=False)) / (len(rtts) - 1)


def ping_summary(rtts: list[float], sent: int) -> CheckResult:
    if sent <= 0:
        return CheckResult(up=False, error="Nie wysłano pakietów")
    loss = round(100.0 * (sent - len(rtts)) / sent, 1)
    if not rtts:
        return CheckResult(up=False, loss_percent=loss, error="Brak odpowiedzi na ping")
    return CheckResult(up=True, latency_ms=round(sum(rtts) / len(rtts), 2), loss_percent=loss, jitter_ms=_round(jitter(rtts)))


def _round(v: float | None) -> float | None:
    return round(v, 2) if v is not None else None


async def _resolve(host: str, port: int | None = None) -> tuple[int, str]:
    """Adres IP hosta (najpierw IPv4)."""
    loop = asyncio.get_running_loop()
    infos = await loop.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    infos.sort(key=lambda i: i[0] != socket.AF_INET)
    family, *_, addr = infos[0]
    return family, addr[0]


def echo_request(seq: int, v6: bool) -> bytes:
    # typ 8 (IPv4) / 128 (IPv6), kod 0; suma kontrolna i identyfikator – uzupełnia jądro
    payload = os.urandom(8)
    return struct.pack("!BBHHH", 128 if v6 else 8, 0, 0, 0, seq) + payload


def parse_echo_reply(data: bytes, v6: bool) -> int | None:
    """Numer sekwencji z odpowiedzi echo (gniazdo DGRAM oddaje sam nagłówek ICMP, bez IP)."""
    if len(data) < 8 or data[0] != (129 if v6 else 0):
        return None
    return struct.unpack("!H", data[6:8])[0]


async def ping(host: str, timeout: float = 5.0, count: int = PING_COUNT, gap: float = PING_GAP_S) -> CheckResult:
    try:
        family, ip = await asyncio.wait_for(_resolve(host), timeout)
    except (OSError, TimeoutError) as exc:
        return CheckResult(up=False, error=f"Nie znaleziono hosta: {_err(exc)}")
    v6 = family == socket.AF_INET6
    try:
        sock = socket.socket(family, socket.SOCK_DGRAM, socket.IPPROTO_ICMPV6 if v6 else socket.IPPROTO_ICMP)
    except OSError as exc:
        return CheckResult(up=False, error=f"Ping niedostępny w systemie (gniazdo ICMP): {_err(exc)}")
    sock.setblocking(False)
    loop = asyncio.get_running_loop()
    base = int.from_bytes(os.urandom(2), "big") & 0x7FFF  # różne serie się nie mieszają
    sent_at: dict[int, float] = {}
    rtts: dict[int, float] = {}
    all_back = loop.create_future()

    # Gniazdo obsługujemy sami (sendto + add_reader), a nie przez loop.sock_sendto/sock_recv – tych nie ma uvloop,
    # na którym działa API (przycisk „Sprawdź teraz”); kolektor ma zwykłą pętlę asyncio.
    def on_readable() -> None:
        while True:
            try:
                data = sock.recv(2048)
            except BlockingIOError:
                return
            except OSError:  # np. „host nieosiągalny” z routera – dotyczy jednego pakietu
                continue
            seq = parse_echo_reply(data, v6)
            if seq in sent_at and seq not in rtts:
                rtts[seq] = (time.monotonic() - sent_at[seq]) * 1000.0
                if len(rtts) >= count and not all_back.done():
                    all_back.set_result(None)

    loop.add_reader(sock.fileno(), on_readable)
    sent = 0
    try:
        for i in range(count):
            seq = (base + i) & 0xFFFF
            sent_at[seq] = time.monotonic()
            try:
                sock.sendto(echo_request(seq, v6), (ip, 0))
                sent += 1
            except OSError as exc:  # także BlockingIOError – pakiet się nie zmieścił, liczy się jako niewysłany
                sent_at.pop(seq, None)
                if sent == 0 and i == count - 1:
                    return CheckResult(up=False, error=f"Błąd wysyłania pinga: {_err(exc)}")
            if i < count - 1:
                await asyncio.sleep(gap)
        try:
            await asyncio.wait_for(asyncio.shield(all_back), timeout)
        except TimeoutError:
            pass
    finally:
        loop.remove_reader(sock.fileno())
        sock.close()
    ordered = [rtts[s] for s in sent_at if s in rtts]
    return ping_summary(ordered, sent)


def status_ok(code: int, expect: str | None) -> bool:
    """Oczekiwany kod HTTP: „200-399” (domyślnie), „200,204”, „2xx” albo ich lista po przecinku."""
    rules = [r.strip().lower() for r in (expect or "200-399").split(",") if r.strip()]
    for rule in rules:
        if rule.endswith("xx") and rule[:-2].isdigit():
            if code // 100 == int(rule[:-2]):
                return True
        elif "-" in rule:
            low, _, high = rule.partition("-")
            if low.strip().isdigit() and high.strip().isdigit() and int(low) <= code <= int(high):
                return True
        elif rule.isdigit() and code == int(rule):
            return True
    return False


def valid_expect(expect: str) -> bool:
    rules = [r.strip().lower() for r in expect.split(",")]
    for rule in rules:
        low, _, high = rule.partition("-")
        if not (rule.isdigit() or (rule.endswith("xx") and rule[:-2].isdigit()) or (low.strip().isdigit() and high.strip().isdigit())):
            return False
    return bool(rules)


def cert_days_left(not_after: datetime, now: datetime | None = None) -> float:
    return round((not_after - (now or datetime.now(UTC))).total_seconds() / 86400, 1)


async def cert_days(host: str, port: int, timeout: float) -> float | None:
    """Dni do wygaśnięcia certyfikatu serwera (bez weryfikacji – chodzi o datę, nie o zaufanie)."""
    from cryptography import x509

    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    try:
        _, writer = await asyncio.wait_for(asyncio.open_connection(host, port, ssl=ctx, server_hostname=host), timeout)
    except (OSError, TimeoutError, ssl.SSLError):
        return None
    try:
        der = writer.get_extra_info("ssl_object").getpeercert(binary_form=True)
        if not der:
            return None
        return cert_days_left(x509.load_der_x509_certificate(der).not_valid_after_utc)
    except (ValueError, AttributeError):
        return None
    finally:
        writer.close()


async def http_check(
    url: str,
    timeout: float = 5.0,
    expect: str | None = None,
    keyword: str | None = None,
    verify_tls: bool = True,
    transport: httpx.AsyncBaseTransport | None = None,
) -> CheckResult:
    started = time.monotonic()
    try:
        async with httpx.AsyncClient(verify=verify_tls, follow_redirects=True, timeout=timeout, transport=transport,
                                     headers={"User-Agent": USER_AGENT}) as client:  # fmt: skip
            async with client.stream("GET", url) as resp:
                latency = (time.monotonic() - started) * 1000.0
                body = b""
                if keyword:
                    async for chunk in resp.aiter_bytes():
                        body += chunk
                        if len(body) >= MAX_BODY:
                            break
    except httpx.TimeoutException:
        return CheckResult(up=False, error=f"Brak odpowiedzi w {timeout:g} s")
    except httpx.HTTPError as exc:
        return CheckResult(up=False, error=_err(exc))
    result = CheckResult(up=True, latency_ms=round(latency, 2), status_code=resp.status_code)
    if not status_ok(resp.status_code, expect):
        result.up, result.error = False, f"Kod HTTP {resp.status_code} (oczekiwany {expect or '200-399'})"
    elif keyword and keyword.encode() not in body:
        result.up, result.error = False, f"W odpowiedzi nie ma tekstu „{keyword[:60]}”"
    parts = urlsplit(url)
    if parts.scheme == "https" and parts.hostname and transport is None:
        result.cert_days = await cert_days(parts.hostname, parts.port or 443, timeout)
    return result


async def tcp_check(host: str, port: int, timeout: float = 5.0) -> CheckResult:
    started = time.monotonic()
    try:
        _, writer = await asyncio.wait_for(asyncio.open_connection(host, port), timeout)
    except TimeoutError:
        return CheckResult(up=False, error=f"Brak połączenia z portem {port} w {timeout:g} s")
    except OSError as exc:
        return CheckResult(up=False, error=f"Port {port}: {_err(exc)}")
    latency = (time.monotonic() - started) * 1000.0
    writer.close()
    try:
        await writer.wait_closed()
    except OSError:
        pass
    return CheckResult(up=True, latency_ms=round(latency, 2))


async def run_check(kind: str, target: str, port: int | None = None, timeout: float = 5.0, expect: str | None = None,
                    keyword: str | None = None, verify_tls: bool = True) -> CheckResult:  # fmt: skip
    try:
        if kind == "ping":
            return await ping(target, timeout)
        if kind == "http":
            return await http_check(target, timeout, expect, keyword, verify_tls)
        if kind == "tcp" and port:
            return await tcp_check(target, port, timeout)
        return CheckResult(up=False, error=f"Nieznany rodzaj sprawdzenia: {kind}")
    except Exception as exc:  # ostatnia linia obrony: jedno sprawdzenie nie może zatrzymać kolektora
        return CheckResult(up=False, error=_err(exc))
