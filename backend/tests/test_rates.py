from netpulse.rates import CounterTracker, counter_delta


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
