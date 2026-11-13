"""Testy odporności na nieznany sprzęt (docs/26-plan-testow-sprzetu.md, etap 1) – bez prawdziwych urządzeń.

- R6: „zepsuty” agent (`fixtures/broken-agent.snmprec`, syntetyczny): NUL i bajty spoza UTF-8, sysName 300 znaków,
  ifSpeed / ifHighSpeed 2³²−1, puste ifName, indeks, który nie jest liczbą, brak części kolumn, ssCpuIdle 250,
- R5: duże urządzenie (kilkaset portów i VLAN-ów) i urządzenie, które odpowiada za wolno (limit czasu odczytu),
- R1: liczniki 32-bitowe przekręcone z dolnej połowy zakresu, zerowanie liczników bez restartu,
- R7: urządzenie bez UCD-SNMP-MIB – CPU i RAM to brak danych, nie 0,
- R9: czytelne komunikaty błędów SNMP (v1/v3 kontra snmpsim – w test_snmp_integration.py).

Zapis tych odczytów do prawdziwej bazy: test_collector_db.py::test_broken_and_big_devices_are_saved.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import replace

import pytest
from conftest import FIXTURES

from netpulse.drivers import DRIVERS, poll_device
from netpulse.drivers.base import InterfaceSample, PollResult, SystemInfo
from netpulse.drivers.generic import link_speed_mbps
from netpulse.rates import CounterTracker, counter_delta
from netpulse.snmp import as_str
from netpulse.snmp import oids as O
from netpulse.snmp.snmprec import SnmprecClient

CONTROL = {chr(c) for c in [*range(0x20), 0x7F]}


def broken() -> SnmprecClient:
    return SnmprecClient.from_file(FIXTURES / "broken-agent.snmprec")


def clean(text: str | None) -> bool:
    return text is None or not (set(text) & CONTROL)


# --- R6: zepsuty agent -------------------------------------------------------------------------------------------


def test_broken_agent_is_read_by_generic_driver():
    r = asyncio.run(poll_device(broken()))
    assert r.driver == "generic"
    s = r.system
    assert s.descr and clean(s.descr) and "�" in s.descr  # bajty spoza UTF-8 → znak zastępczy, bez NUL
    assert len(s.name) == 300 and s.contact == ""  # przycięcie do kolumny robi zapis (collector._cut)
    ports = {i.if_index: i for i in r.interfaces}
    # indeks „7.1” pominięty, a nie wywracający odczyt
    assert sorted(ports) == [1, 2, 3, 4, 5, 6]
    assert all(clean(i.name) and clean(i.descr) and clean(i.alias) and clean(i.label) for i in r.interfaces)
    # puste ifName → ifDescr; brak obu → bajty z ifDescr; NUL w środku nazwy usunięty
    assert ports[2].name == "eth0" and ports[6].name == "eth3"
    assert ports[3].name.endswith("port") and ports[3].oper_status == "unknown" and ports[3].admin_up is False
    # ifSpeed 2³²−1 bez ifHighSpeed i ifHighSpeed 2³²−1 to „nie wiadomo”, nie 4294 Mb/s ani 4 Pb/s
    assert ports[2].speed_mbps is None and ports[4].speed_mbps is None and ports[5].speed_mbps is None
    assert ports[1].speed_mbps == 10
    # ifHCInOctets bez ifHCOutOctets – oba kierunki z liczników 32-bitowych (tu brak ifOutOctets)
    assert (ports[5].counter_bits, ports[5].in_octets, ports[5].out_octets) == (32, 500, None)
    assert (ports[4].counter_bits, ports[4].in_octets) == (64, 10**12)
    assert ports[2].mac is None  # adres MAC z 5 bajtów
    assert ports[1].hidden and ports[1].role == "system"  # loopback po ifType
    assert len(ports[4].alias) == 402 and " B" in ports[4].alias  # nowa linia → spacja
    # ssCpuIdle 250 i memTotalReal 0 – brak danych, nie ujemne CPU i nie 0 % RAM
    assert r.health.cpu_percent is None and r.health.mem_used_percent is None


@pytest.mark.parametrize("driver", sorted(DRIVERS))
def test_every_driver_survives_broken_agent(driver):
    """Driver wybrany ręcznie (albo źle rozpoznany) nie wysypuje się na dziwnych danych."""
    r = asyncio.run(poll_device(broken(), driver))
    assert r.interfaces
    assert all(clean(i.name) for i in r.interfaces)


def test_every_driver_match_survives_odd_system():
    for system in (
        SystemInfo(),
        SystemInfo(descr="", object_id=""),
        SystemInfo(descr="��", object_id="1.3.6.1.4.1"),
        SystemInfo(descr="Linux", object_id="not-an-oid", name="x" * 1000),
    ):
        for cls in DRIVERS.values():
            assert 0 <= cls.match(system) <= 100


def test_as_str_drops_control_characters():
    assert as_str(b"ab\x00c\x07\r\n d \x7f") == "abc  d"
    assert as_str(b"\xff\xfe") == "��"
    assert as_str(b"\x00\x00") == ""
    assert as_str("tab\there") == "tab here"
    assert as_str(7) == "7"


def test_link_speed():
    assert link_speed_mbps(1000, 1_000_000_000) == 1000
    assert link_speed_mbps(0, 100_000_000) == 100
    assert link_speed_mbps(None, 4_294_967_295) is None
    assert link_speed_mbps(4_294_967_295, 4_294_967_295) is None
    assert link_speed_mbps(10_000, 4_294_967_295) == 10_000
    assert link_speed_mbps(None, 64_000) is None  # łącze 64 kb/s – mniej niż 1 Mb/s, prędkość nieznana
    assert link_speed_mbps(None, 0) is None
    assert link_speed_mbps(-1, -1) is None


# --- R5: duże i wolne urządzenie ----------------------------------------------------------------------------------


def big_device(ports: int = 52, vlans: int = 500) -> SnmprecClient:
    """Switch z 52 portami i 500 VLAN-ami (interfejsy l2vlan) – jak duży switch zarządzalny."""
    data: dict = {
        O.SYS_DESCR: b"Big Switch 9000",
        O.SYS_OBJECT_ID: "1.3.6.1.4.1.99999.2",
        O.SYS_UPTIME: 1000,
        O.SYS_NAME: b"big",
    }
    for idx in range(1, ports + vlans + 1):
        vlan = idx > ports
        name = f"vlan{idx - ports}" if vlan else f"Gi1/0/{idx}"
        data[f"{O.IF_DESCR}.{idx}"] = name.encode()
        data[f"{O.IF_NAME}.{idx}"] = name.encode()
        data[f"{O.IF_TYPE}.{idx}"] = 135 if vlan else 6
        data[f"{O.IF_OPER_STATUS}.{idx}"] = 1
        data[f"{O.IF_HIGH_SPEED}.{idx}"] = 1000
        data[f"{O.IF_HC_IN_OCTETS}.{idx}"] = idx * 1000
        data[f"{O.IF_HC_OUT_OCTETS}.{idx}"] = idx * 2000
    return SnmprecClient(data)


def test_big_device_is_read_quickly():
    client = big_device()
    started = time.monotonic()
    r = asyncio.run(poll_device(client))
    assert time.monotonic() - started < 5
    assert len(r.interfaces) == 552
    assert r.health.cpu_percent is None  # bez UCD-SNMP-MIB (R7)
    assert len({i.if_index for i in r.interfaces}) == 552


class SlowClient:
    """Urządzenie odpowiadające po `delay` s na każde zapytanie."""

    def __init__(self, inner, delay: float) -> None:
        self.inner, self.delay = inner, delay

    async def get(self, oids):
        await asyncio.sleep(self.delay)
        return await self.inner.get(oids)

    async def walk(self, oid):
        await asyncio.sleep(self.delay)
        return await self.inner.walk(oid)

    async def close(self):
        pass


def _collector(monkeypatch, client, **settings_overrides):
    from netpulse import collector as col

    monkeypatch.setattr(col, "settings", replace(col.settings, **settings_overrides))
    c = col.Collector(client_factory=lambda target: client)
    failures: list[str] = []
    saved: list[PollResult] = []

    async def save_failure(target, now, error):
        failures.append(error)

    async def save_result(target, result, now, poll_ms, read_ts=None):
        saved.append(result)

    monkeypatch.setattr(c, "save_failure", save_failure)
    monkeypatch.setattr(c, "save_result", save_result)
    target = col.DeviceTarget(1, "slow", "10.0.0.9", 161, "auto", None)
    return c, target, failures, saved


def test_slow_device_hits_poll_timeout(monkeypatch):
    """Wolne urządzenie nie wstrzymuje cyklu: po limicie czasu „nie odpowiada” z wyjaśnieniem."""
    c, target, failures, saved = _collector(monkeypatch, SlowClient(big_device(), 0.05), poll_timeout=0.3)
    started = time.monotonic()
    assert asyncio.run(c.poll_one(target)) is None
    assert time.monotonic() - started < 1.5
    assert saved == []
    assert failures == ["Odczyt SNMP trwał dłużej niż 0.3 s – urządzenie odpowiada za wolno albo ma bardzo dużo interfejsów"]


def test_poll_timeout_defaults():
    from netpulse.config import settings

    assert replace(settings, poll_interval=30, poll_timeout=None).effective_poll_timeout == 25
    assert replace(settings, poll_interval=5, poll_timeout=None).effective_poll_timeout == 20
    assert replace(settings, poll_timeout=0).effective_poll_timeout == 0
    assert replace(settings, poll_timeout=7.5).effective_poll_timeout == 7.5


def test_slow_device_within_timeout_is_saved(monkeypatch):
    c, target, failures, saved = _collector(monkeypatch, SlowClient(broken(), 0.01), poll_timeout=0)
    assert asyncio.run(c.poll_one(target)) is not None
    assert failures == [] and len(saved) == 1


def test_save_error_marks_device_instead_of_breaking_cycle(monkeypatch):
    c, target, failures, _ = _collector(monkeypatch, broken())

    async def boom(*args, **kwargs):
        raise ValueError("value too long for type character varying(64)")

    monkeypatch.setattr(c, "save_result", boom)
    assert asyncio.run(c.poll_one(target)) is None
    assert failures == ["Błąd zapisu odczytu: ValueError"]


# --- R1: liczniki 32-bitowe ---------------------------------------------------------------------------------------


def test_counter32_wrap_from_lower_half_on_fast_link():
    """900 Mb/s na łączu 1 Gb/s z licznikami 32-bitowymi: licznik przekręca się co ~38 s, często z dolnej połowy
    zakresu – każda próbka ma być policzona (wcześniej co kilka cykli „reset” i dziura na wykresie)."""
    t = CounterTracker()
    step = int(900e6 / 8 * 30)  # bajtów na 30 s
    value = 3_000_000_000
    t.bps("k", 0.0, value, 32, 1000, 1.1)
    got = []
    for n in range(1, 21):
        value = (value + step) % 2**32
        got.append(t.bps("k", n * 30.0, value, 32, 1000, 1.1))
    assert all(v is not None and abs(v - 900e6) < 1 for v in got), got
    assert not t.was_reset("k")


def test_counter32_drop_without_link_speed_stays_reset():
    # Bez prędkości łącza nie da się odróżnić zawinięcia z dolnej połowy od wyzerowania – zostaje reset (bez próbki)
    assert counter_delta(1_000_000_000, 455_000_000, 32) is None
    assert counter_delta(1_000_000_000, 455_000_000, 32, max_delta=4e9) == 455_000_000 + 2**32 - 1_000_000_000
    # przyrost przez zawinięcie większy niż możliwy – reset
    assert counter_delta(1_000_000_000, 455_000_000, 32, max_delta=1e9) is None
    # Counter64 bez zmian: spadek = reset
    assert counter_delta(10**12, 5, 64, max_delta=1e15) is None


def test_counters_zeroed_without_restart():
    """Liczniki wyzerowane ręcznie (clear counters), uptime bez zmian: ta próbka bez ruchu w obu kierunkach,
    następna normalnie – bez ujemnych i ogromnych skoków."""
    from netpulse.collector import Collector

    c = Collector()

    def poll(ts: float, rx: int, tx: int, bits: int = 64) -> dict:
        port = InterfaceSample(
            if_index=3, name="Gi1/0/3", if_type=6, oper_status="up", speed_mbps=1000, in_octets=rx, out_octets=tx, counter_bits=bits
        )
        rates, _ = c.compute_rates(1, PollResult(driver="generic", system=SystemInfo(uptime_s=ts + 1000), interfaces=[port]), ts)
        return rates.get(3, {})

    poll(0.0, 50_000_000_000, 9_000_000_000)
    assert poll(30.0, 50_375_000_000, 9_037_500_000)["in_bps"] == 100_000_000.0
    zeroed = poll(60.0, 1_000, 500)
    assert zeroed.get("in_bps") is None and zeroed.get("out_bps") is None
    after = poll(90.0, 375_001_000, 37_500_500)
    assert after["in_bps"] == 100_000_000.0 and after["out_bps"] == 10_000_000.0


# --- R9: komunikaty błędów ----------------------------------------------------------------------------------------


def test_snmp_errors_are_explained():
    from pysnmp.proto import errind

    from netpulse.i18n import translate
    from netpulse.snmp.client import explain

    assert explain(errind.requestTimedOut).startswith("brak odpowiedzi w wyznaczonym czasie")
    assert explain(errind.wrongDigest) == "zły klucz albo protokół uwierzytelniania SNMPv3 (auth)"
    assert explain(errind.unknownUserName) == "urządzenie nie zna tego użytkownika SNMPv3"
    assert explain(errind.decryptionError) == "zły klucz albo protokół szyfrowania SNMPv3 (priv)"
    assert explain("coś innego") == "coś innego"
    # komunikat „Test SNMP” po angielsku
    msg = f"Brak odpowiedzi SNMP z 10.0.0.1: {explain(errind.wrongDigest)}"
    assert translate(msg, "en") == "No SNMP response from 10.0.0.1: wrong SNMPv3 authentication key or protocol (auth)"
    assert translate(explain(errind.requestTimedOut), "en").startswith("no response in time")
