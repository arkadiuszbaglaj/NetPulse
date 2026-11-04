from netpulse.rates import CounterTracker, counter_delta, rate_factor


def test_counter_delta_basic():
    assert counter_delta(100, 250) == 150


def test_counter32_wrap():
    assert counter_delta(2**32 - 10, 5, bits=32) == 15


def test_counter64_reset_is_none():
    assert counter_delta(10_000, 50, bits=64) is None


def test_counter32_small_drop_is_reset():
    assert counter_delta(1000, 10, bits=32) is None


def test_tracker_bps():
    t = CounterTracker()
    assert t.bps("k", 0.0, 1_000) is None  # pierwszy odczyt
    assert t.bps("k", 10.0, 126_000) == 100_000.0  # 125 000 B / 10 s * 8


def test_tracker_rejects_impossible_rate():
    t = CounterTracker()
    t.bps("k", 0.0, 0, max_mbps=100)
    # 1 GB w 1 s na łączu 100 Mb/s – niemożliwe
    assert t.bps("k", 1.0, 1_000_000_000, max_mbps=100) is None


def test_tracker_forget():
    t = CounterTracker()
    t.update((1, "a"), 0.0, 10)
    t.update((2, "a"), 0.0, 10)
    t.forget(lambda k: k[0] == 1)
    assert t.update((1, "a"), 1.0, 20) is None
    assert t.update((2, "a"), 1.0, 20) == (10, 1.0)


def test_live_rate_holds_value_while_counter_is_stale():
    """UniFi odświeża liczniki co kilka sekund: przy odczytach co 1,5 s szybkość nie spada co drugi raz do 0."""
    from netpulse.rates import LiveRateTracker

    t = LiveRateTracker(hold_s=6.0)
    assert t.bps("p", 0.0, 1_000) is None  # pierwszy odczyt
    assert t.bps("p", 1.5, 1_000) is None  # licznik jeszcze stoi, nie znamy szybkości
    assert t.bps("p", 3.0, 4_000) == 3_000 * 8 / 3.0  # od ostatniej zmiany (0 s), nie od poprzedniego odczytu
    assert t.bps("p", 4.5, 4_000) == 8_000  # stoi – poprzednia szybkość
    assert t.bps("p", 6.0, 7_000) == 3_000 * 8 / 3.0
    assert t.bps("p", 13.0, 7_000) == 0.0  # stoi dłużej niż 6 s – port nic nie przesyła
    assert t.bps("p", 14.5, 100) is None  # reset licznika


def test_ethernet_port_rejects_rate_over_link_speed():
    """Port Ethernet 1 Gb/s: 1,16 Gb/s to licznik „doganiający” ruch, nie prawdziwy odczyt (od 0.54.4)."""
    assert rate_factor(6) == 1.1
    assert rate_factor(None) == 2.0  # interfejs bez typu (most, VLAN) – prędkość bywa umowna
    t = CounterTracker()
    t.bps("k", 0.0, 0, max_mbps=1000, factor=rate_factor(6))
    assert t.bps("k", 30.0, 4_340_000_000, max_mbps=1000, factor=rate_factor(6)) is None  # 1157 Mb/s
    assert (
        t.bps("k", 60.0, 4_340_000_000 + 3_750_000_000, max_mbps=1000, factor=rate_factor(6))
        == 1_000_000_000.0
    )


def test_tracker_remembers_reset():
    t = CounterTracker()
    t.update("k", 0.0, 1_000)
    assert t.update("k", 30.0, 10) is None
    assert t.was_reset("k")
    assert t.update("k", 60.0, 20) == (10, 30.0)
    assert not t.was_reset("k")


def test_collector_skips_sample_when_link_goes_down_or_up():
    """WAN wraca po przerwie (UCG Ultra, 4.11.2026): pobieranie spada (reset), wysyłanie skacze o kilka GB – oba kierunki
    tej próbki odrzucone, od następnej liczymy normalnie."""
    from netpulse.collector import Collector
    from netpulse.drivers.base import InterfaceSample, PollResult, SystemInfo

    c = Collector()

    def poll(ts: float, oper: str, rx: int, tx: int) -> dict:
        port = InterfaceSample(
            if_index=5, name="eth4", if_type=6, oper_status=oper, speed_mbps=1000, in_octets=rx, out_octets=tx
        )
        rates, _ = c.compute_rates(1, PollResult(driver="unifi", system=SystemInfo(), interfaces=[port]), ts)
        return rates.get(5, {})

    poll(0.0, "up", 10_000_000, 2_000_000)
    assert poll(30.0, "up", 10_375_000, 2_037_500)["in_bps"] == 100_000.0
    down = poll(60.0, "down", 10_375_000, 2_037_500)
    assert down["in_bps"] is None and down["out_bps"] is None and down["oper_up"] is False
    assert poll(90.0, "down", 10_375_000, 2_037_500)["in_bps"] == 0.0
    back = poll(120.0, "up", 5_000, 2_037_500 + 4_300_000_000)
    assert back["in_bps"] is None and back["out_bps"] is None
    assert poll(150.0, "up", 380_000, 2_037_500 + 4_300_375_000) == {
        "in_bps": 100_000.0,
        "out_bps": 100_000.0,
        "in_errors": None,
        "out_errors": None,
        "in_discards": None,
        "out_discards": None,
        "oper_up": True,
    }
