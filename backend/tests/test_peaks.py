"""Szczyt ruchu WAN (od 0.70.0) i test prędkości bramy z kontrolera UniFi – logika bez bazy."""

from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace

from netpulse.collector import Collector
from netpulse.peaks import PeakSampler, PeakTracker
from netpulse.unifi import Speedtest, parse_devices, parse_speedtest
from netpulse.unifi_collector import speedtest_rows

MBPS = 1_000_000 / 8  # bajtów na sekundę przy 1 Mb/s


def feed(tracker: PeakTracker, key, rates_mbps: list[float], start: float = 0.0, step: float = 1.0) -> None:
    """Licznik odświeżany co `step` s; `rates_mbps[i]` to prędkość w i-tej sekundzie."""
    octets = 0
    tracker.add(key, start, octets)
    for i, rate in enumerate(rates_mbps, start=1):
        octets += int(rate * MBPS * step)
        tracker.add(key, start + i * step, octets)


def test_short_burst_shows_as_peak_not_as_half_minute_average():
    """Test prędkości 455 Mb/s przez 7 s w 30-sekundowym cyklu: średnia ok. 106 Mb/s, szczyt 455 Mb/s."""
    tracker = PeakTracker()
    rates = [1.0] * 10 + [455.0] * 7 + [1.0] * 13
    feed(tracker, "wan", rates)
    assert sum(rates) / len(rates) < 110
    assert round(tracker.take("wan") / 1e6) == 455
    assert tracker.take("wan") is None  # odebrany – następny cykl liczy od nowa


def test_burst_shorter_than_window_is_averaged_over_the_window():
    tracker = PeakTracker()
    feed(tracker, "wan", [1.0] * 5 + [500.0] * 2 + [1.0] * 8)
    assert 195 <= tracker.take("wan") / 1e6 <= 205  # 2 s × 500 Mb/s w oknie 5 s


def test_steady_traffic_peak_equals_rate():
    tracker = PeakTracker()
    feed(tracker, "wan", [80.0] * 30)
    assert round(tracker.take("wan") / 1e6) == 80


def test_no_full_window_means_no_peak():
    tracker = PeakTracker()
    feed(tracker, "wan", [100.0] * 3)
    assert tracker.take("wan") is None


def test_repeated_reads_of_stale_counter_do_not_fake_a_peak():
    """Licznik odświeżany co 10 s, odczyt co sekundę: okno samo wydłuża się do odstępu zmian (bez „0, potem podwójnie”)."""
    tracker = PeakTracker()
    octets, ts = 0, 0.0
    tracker.add("wan", ts, octets)
    for _ in range(4):
        for _ in range(9):
            ts += 1.0
            tracker.add("wan", ts, octets)  # ta sama wartość – licznik jeszcze stoi
        ts += 1.0
        octets += int(100 * MBPS * 10)
        tracker.add("wan", ts, octets)
    assert round(tracker.take("wan") / 1e6) == 100


def test_counter_reset_and_impossible_rate_are_ignored():
    tracker = PeakTracker()
    feed(tracker, "wan", [50.0] * 10)
    tracker.add("wan", 11.0, 5)  # reset urządzenia – licznik spadł
    assert round(tracker.take("wan") / 1e6) == 50
    tracker.add("wan", 12.0, 5 + int(50 * MBPS))
    tracker.add("wan", 13.0, 5 + int(100 * MBPS))
    assert tracker.take("wan") is None  # po resecie jeszcze nie ma pełnego okna
    # 5 Gb/s na łączu 1 Gb/s to błąd licznika, nie szczyt
    limited = PeakTracker()
    octets = 0
    limited.add("wan", 0.0, octets, max_bps=1.1e9)
    for i in range(1, 8):
        octets += int(5000 * MBPS)
        limited.add("wan", float(i), octets, max_bps=1.1e9)
    assert limited.take("wan") is None


def _port(in_octets: int, out_octets: int) -> SimpleNamespace:
    return SimpleNamespace(
        if_index=5, name="eth4", if_type=6, speed_mbps=1000, counter_bits=64, oper_status="up",
        in_octets=in_octets, out_octets=out_octets, in_errors=0, out_errors=0, in_discards=0, out_discards=0,
    )  # fmt: skip


def test_collector_stores_peak_next_to_average_and_never_below_it():
    sampler = PeakSampler(client_factory=None, interval=1)
    collector = Collector(client_factory=None, peaks=sampler)

    def poll(coll: Collector, ts: float, in_octets: int, out_octets: int) -> dict:
        result = SimpleNamespace(interfaces=[_port(in_octets, out_octets)], wifi=[])
        return coll.compute_rates(1, result, ts)[0]  # type: ignore[arg-type]

    poll(collector, 0.0, 0, 0)
    sampler.tracker._peak[(1, 5, "in")] = 455e6  # zmierzone między cyklami
    sampler.tracker._peak[(1, 5, "out")] = 1e6  # niżej niż średnia z cyklu (okna się nie pokrywają)
    rates = poll(collector, 30.0, int(100 * MBPS * 30), int(20 * MBPS * 30))[5]
    assert round(rates["in_bps"] / 1e6) == 100 and rates["in_bps_max"] == 455e6
    assert round(rates["out_bps"] / 1e6) == 20 and rates["out_bps_max"] == rates["out_bps"]
    # Bez pomiaru szczytu w cyklu – kolumn nie ma (NULL w bazie)
    rates = poll(collector, 60.0, int(100 * MBPS * 60), int(20 * MBPS * 60))[5]
    assert "in_bps_max" not in rates and "out_bps_max" not in rates
    # Kolektor bez próbnika (testy, CLI) działa jak dotąd
    plain = Collector(client_factory=None)
    poll(plain, 0.0, 0, 0)
    assert "in_bps_max" not in poll(plain, 30.0, 1000, 1000)[5]


# --- test prędkości bramy ---------------------------------------------------------------

GATEWAY = {
    "type": "ucg",
    "mac": "02:00:00:00:00:01",
    "name": "UCG Ultra",
    "speedtest-status": {
        "latency": 6,
        "rundate": 1794510502,
        "runtime": 17,
        "server": {"cc": "PL", "city": "Radomsko", "provider": "CRONEL.NET Sp. z o. o."},
        "source_interface": "if!eth4",
        "status_download": 2,
        "status_ping": 2,
        "status_summary": 2,
        "status_upload": 2,
        "xput_download": 455.0,
        "xput_upload": 51.0,
    },
    "uplink": {"name": "eth4", "up": True},
}


def test_speedtest_from_real_controller_answer():
    """Pola `speedtest-status` tak, jak je zwrócił kontroler UCG Ultra 12.11.2026 (test 455 / 51 Mb/s, ping 6 ms)."""
    st = parse_speedtest(GATEWAY)
    assert st == Speedtest("eth4", 1794510502.0, 455.0, 51.0, 6.0, 17.0, "CRONEL.NET Sp. z o. o., Radomsko")
    (device,) = parse_devices({"data": [GATEWAY]})
    assert device.speedtest == st
    rows = {r["name"]: r for r in speedtest_rows(7, st)}
    assert rows["speedtest_down_bps"]["value"] == 455_000_000 and rows["speedtest_up_bps"]["value"] == 51_000_000
    assert rows["speedtest_ping_ms"]["value"] == 6.0
    # Punkt ma czas samego testu, nie odczytu – powtórny odczyt tego samego wyniku trafia w ten sam wiersz
    assert {r["time"] for r in rows.values()} == {datetime.fromtimestamp(1794510502, UTC)}
    assert {r["key"] for r in rows.values()} == {"eth4"} and {r["device_id"] for r in rows.values()} == {7}


def test_speedtest_missing_running_or_failed_is_skipped():
    def with_status(**changes) -> dict:
        return {**GATEWAY, "speedtest-status": {**GATEWAY["speedtest-status"], **changes}}

    assert parse_speedtest({**GATEWAY, "speedtest-status": None}) is None
    assert parse_speedtest({k: v for k, v in GATEWAY.items() if k != "speedtest-status"}) is None
    assert parse_speedtest(with_status(status_summary=1)) is None  # test trwa
    assert parse_speedtest(with_status(xput_download=0)) is None
    assert parse_speedtest(with_status(xput_upload=-1)) is None
    assert parse_speedtest(with_status(rundate=0)) is None
    assert parse_speedtest({**GATEWAY, "type": "usw"}) is None  # tylko bramy
    # Starsza wersja kontrolera: `interface_name` zamiast `source_interface`; bez obu – interfejs uplinku
    old = with_status(interface_name="eth4")
    del old["speedtest-status"]["source_interface"]
    assert parse_speedtest(old).ifname == "eth4"
    del old["speedtest-status"]["interface_name"]
    assert parse_speedtest(old).ifname == "eth4"
    assert parse_speedtest(with_status(latency=-1)).latency_ms is None
