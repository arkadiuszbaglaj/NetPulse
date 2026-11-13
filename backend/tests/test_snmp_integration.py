"""Prawdziwy klient pysnmp kontra symulator snmpsim (v2c i v3).

Symulator serwuje pliki z tests/fixtures; community (v2c) i context (v3) = nazwa pliku.
Uruchamiane automatycznie, gdy snmpsim jest zainstalowany (pip install -e '.[dev]').
"""

from __future__ import annotations

import asyncio
import shutil
import socket
import subprocess
import time

import pytest
from conftest import FIXTURES

pytestmark = pytest.mark.integration

RESPONDER = shutil.which("snmpsim-command-responder")
if RESPONDER is None:
    pytest.skip("snmpsim nie jest zainstalowany", allow_module_level=True)

from netpulse.drivers import poll_device  # noqa: E402
from netpulse.snmp import SnmpCredentials, SnmpError  # noqa: E402
from netpulse.snmp.client import PySnmpClient  # noqa: E402


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="module")
def agent(tmp_path_factory):
    port = _free_port()
    cache = tmp_path_factory.mktemp("snmpsim-cache")
    log_path = cache / "snmpsim.log"
    log_file = open(log_path, "w")  # noqa: SIM115 - zamykany po teście
    proc = subprocess.Popen(
        [
            RESPONDER,
            f"--data-dir={FIXTURES}",
            f"--cache-dir={cache}",
            f"--agent-udpv4-endpoint=127.0.0.1:{port}",
            "--v3-user=netpulse",
            "--v3-auth-key=netpulse-auth",
            "--v3-auth-proto=SHA",
            "--v3-priv-key=netpulse-priv",
            "--v3-priv-proto=AES",
        ],
        stdout=log_file,
        stderr=subprocess.STDOUT,
    )
    # Rozgrzewka: snmpsim indeksuje każdy plik przy pierwszym dostępie
    for community in ("usw-lite-8-poe", "ucg-ultra", "u6-plus"):
        creds = SnmpCredentials(version="2c", community=community)
        deadline = time.time() + 60
        while time.time() < deadline:
            if proc.poll() is not None:
                pytest.fail(f"snmpsim zakończył się:\n{log_path.read_text()[-3000:]}")
            client = PySnmpClient("127.0.0.1", creds, port=port, timeout=2, retries=0)
            try:
                if asyncio.run(client.walk("1.3.6.1.2.1.2.2.1.2")):
                    break
            except SnmpError:
                pass
            finally:
                asyncio.run(client.close())
            time.sleep(0.5)
        else:
            proc.kill()
            pytest.fail(f"snmpsim nie odpowiada dla {community}:\n{log_path.read_text()[-3000:]}")
    yield port
    proc.terminate()
    proc.wait(10)
    log_file.close()


def _poll(port: int, creds: SnmpCredentials):
    async def run():
        client = PySnmpClient("127.0.0.1", creds, port=port, timeout=5, retries=1)
        try:
            return await poll_device(client)
        finally:
            await client.close()

    return asyncio.run(run())


@pytest.mark.parametrize(
    ("community", "kind", "visible"),
    [("ucg-ultra", "gateway", 5), ("usw-lite-8-poe", "switch", 8), ("u6-plus", "ap", 1)],
)
def test_v2c_poll(agent, community, kind, visible):
    r = _poll(agent, SnmpCredentials(version="2c", community=community))
    assert r.system.kind == kind
    assert len(r.visible_interfaces()) == visible
    assert all(i.in_octets is not None for i in r.visible_interfaces())


def test_v2c_wifi(agent):
    r = _poll(agent, SnmpCredentials(version="2c", community="u6-plus"))
    assert sum(w.clients or 0 for w in r.wifi if not w.hidden) == 5


def test_v3_auth_priv(agent):
    creds = SnmpCredentials(
        version="3",
        username="netpulse",
        auth_protocol="SHA",
        auth_key="netpulse-auth",
        priv_protocol="AES",
        priv_key="netpulse-priv",
        context_name="ucg-ultra",
    )
    r = _poll(agent, creds)
    assert r.system.model == "UCG-Ultra"
    assert r.system.kind == "gateway"


def test_wrong_community_raises(agent):
    creds = SnmpCredentials(version="2c", community="zla-community")
    client = PySnmpClient("127.0.0.1", creds, port=agent, timeout=0.5, retries=0)
    with pytest.raises(SnmpError):
        try:
            asyncio.run(poll_device(client))
        finally:
            asyncio.run(client.close())


# --- odporność (docs/26, etap 1: R6, R9) ---------------------------------------------------------------------------


def _error(port: int, creds: SnmpCredentials) -> str:
    client = PySnmpClient("127.0.0.1", creds, port=port, timeout=1, retries=0)
    try:
        with pytest.raises(SnmpError) as exc:
            asyncio.run(poll_device(client))
    finally:
        asyncio.run(client.close())
    return str(exc.value)


def test_wrong_community_says_what_to_check(agent):
    assert _error(agent, SnmpCredentials(version="2c", community="zla-community")).startswith(
        "brak odpowiedzi w wyznaczonym czasie – sprawdź adres, port UDP, wersję SNMP i community"
    )


def _v3(**overrides) -> SnmpCredentials:
    base = dict(
        version="3",
        username="netpulse",
        auth_protocol="SHA",
        auth_key="netpulse-auth",
        priv_protocol="AES",
        priv_key="netpulse-priv",
        context_name="ucg-ultra",
    )
    return SnmpCredentials(**(base | overrides))


def test_v3_wrong_auth_key_is_explained(agent):
    assert _error(agent, _v3(auth_key="zly-klucz-auth")) == "zły klucz albo protokół uwierzytelniania SNMPv3 (auth)"


def test_v3_unknown_user_is_explained(agent):
    assert _error(agent, _v3(username="ktos-obcy")) == "urządzenie nie zna tego użytkownika SNMPv3"


def test_v3_wrong_priv_key_is_explained(agent):
    from netpulse.snmp.client import ERROR_HINTS

    # snmpsim nie odszyfruje zapytania: raport decryptionError albo brak odpowiedzi – w obu razach opis po polsku
    assert _error(agent, _v3(priv_key="zly-klucz-priv")) in ERROR_HINTS.values()


def test_v1_poll_uses_32bit_counters(agent):
    """SNMP v1 nie zna Counter64: driver bierze ifInOctets/ifOutOctets (32 bity)."""
    r = _poll(agent, SnmpCredentials(version="1", community="usw-lite-8-poe"))
    assert r.system.kind == "switch"
    visible = r.visible_interfaces()
    assert len(visible) == 8
    assert all(i.counter_bits == 32 and i.in_octets is not None for i in visible)


def test_broken_agent_over_real_snmp(agent):
    """Zepsuty agent (fixtures/broken-agent.snmprec) przez prawdziwy klient pysnmp – bez wyjątku, bez znaków sterujących."""
    r = _poll(agent, SnmpCredentials(version="2c", community="broken-agent"))
    assert sorted(i.if_index for i in r.interfaces) == [1, 2, 3, 4, 5, 6]
    assert all("\x00" not in i.name for i in r.interfaces)
    assert r.health.cpu_percent is None
