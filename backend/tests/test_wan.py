"""Dual WAN: wybór aktywnego łącza, SLA, przełączenia i porty WAN z kontrolera UniFi (bez bazy)."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

from conftest import FIXTURES

from netpulse.unifi import WanPort, parse_devices, parse_wans
from netpulse.wan import ACTIVE_MIN_BPS, LinkReading, Sample, compute_sla, decide, segments, switches

T0 = datetime(2026, 10, 25, 12, 0, tzinfo=UTC)
GAP = timedelta(seconds=90)


def at(seconds: float) -> datetime:
    return T0 + timedelta(seconds=seconds)


def states(readings) -> dict[int, str]:
    return {k: v.state for k, v in decide(readings).items()}


# --- które łącze jest aktywne ---------------------------------------------------------------------


def test_single_link_up_is_active_even_without_traffic():
    r = decide([LinkReading(1, 1, True, 0, 0), LinkReading(2, 2, False)])
    assert (r[1].state, r[2].state) == ("active", "down")
    assert r[1].source == "traffic"


def test_failover_traffic_decides_active_link():
    # WAN 1 ma link, ale ruch idzie przez WAN 2 (np. awaria u operatora, łącze zapasowe przejęło ruch)
    readings = [LinkReading(1, 1, True, 2_000, 1_000), LinkReading(2, 2, True, 40_000_000, 3_000_000)]
    assert states(readings) == {1: "standby", 2: "active"}


def test_load_balance_marks_both_links_active():
    readings = [LinkReading(1, 1, True, 30_000_000, 0), LinkReading(2, 2, True, 10_000_000, 0)]
    assert states(readings) == {1: "active", 2: "active"}


def test_quiet_network_keeps_previous_active_link():
    quiet = ACTIVE_MIN_BPS / 10
    readings = [LinkReading(1, 1, True, quiet, 0, prev_state="standby"), LinkReading(2, 2, True, 0, 0, prev_state="active")]
    assert states(readings) == {1: "standby", 2: "active"}
    # Bez wcześniejszego stanu – pierwsze w kolejności
    assert states([LinkReading(1, 2, True, 0, 0), LinkReading(2, 1, True, 0, 0)]) == {1: "standby", 2: "active"}


def test_controller_wins_over_traffic_and_reports_internet_down():
    readings = [
        LinkReading(1, 1, True, 50_000_000, 0, ctrl_up=False, ctrl_active=False),  # link jest, internetu nie ma
        LinkReading(2, 2, True, 0, 0, ctrl_up=True, ctrl_active=True),
    ]
    r = decide(readings)
    assert (r[1].state, r[2].state) == ("down", "active")
    assert r[2].source == "controller"


def test_controller_pointing_at_dead_port_falls_back_to_traffic():
    readings = [LinkReading(1, 1, False, ctrl_active=True), LinkReading(2, 2, True, 1_000_000, 0, ctrl_active=False)]
    r = decide(readings)
    assert (r[1].state, r[2].state) == ("down", "active") and r[2].source == "traffic"


def test_missing_interface_is_unknown():
    assert states([LinkReading(1, 1, None), LinkReading(2, 2, True)]) == {1: "unknown", 2: "active"}


# --- historia i SLA -------------------------------------------------------------------------------


def series(spec: list[tuple[float, bool, bool]]) -> list[Sample]:
    return [Sample(at(s), up, active) for s, up, active in spec]


def test_segments_merge_states_and_break_on_gaps():
    samples = series([(0, True, True), (30, True, True), (60, False, False), (90, True, True), (600, True, True)])
    segs = segments(samples, at(0), at(700), GAP)
    assert [(s.state, s.seconds) for s in segs] == [("active", 60), ("down", 30), ("active", 90), ("active", 90)]


def test_sla_counts_outages_and_ignores_missing_data():
    # 10 minut co 30 s; awaria 60 s w 3. minucie i 30 s w 8.; potem 20 minut bez danych
    spec = [(s, True, True) for s in range(0, 600, 30)]
    spec = [(s, s not in (180, 210, 480), s not in (180, 210, 480)) for s, _, _ in spec]
    r = compute_sla(series(spec), at(0), at(1800), GAP)
    assert r.down_s == 90 and r.up_s == 570  # ostatnia próbka (570 s) obowiązuje 90 s – do 660 s
    assert len(r.outages) == 2 and r.longest_s == 60
    assert r.unknown_s == 1800 - r.up_s - r.down_s
    assert r.availability == round(100 * r.up_s / (r.up_s + r.down_s), 3)
    assert not any(o.ongoing for o in r.outages)


def test_sla_ongoing_outage_and_no_data():
    r = compute_sla(series([(0, True, False), (30, False, False), (60, False, False)]), at(0), at(80), GAP)
    assert r.outages[-1].ongoing and r.outages[-1].start == at(30)
    assert r.active_s == 0 and r.up_s == 30
    assert compute_sla([], at(0), at(60), GAP).availability is None


def test_sla_clips_to_period_start():
    r = compute_sla(series([(-60, False, False), (-30, False, False), (0, True, True)]), at(-10), at(30), GAP)
    assert (r.down_s, r.up_s) == (10, 30) and r.outages[0].start == at(-10)


def test_switches_between_links():
    wan1 = series([(0, True, True), (30, False, False), (60, False, False), (90, True, True)])
    wan2 = series([(0, True, False), (30, True, True), (60, True, True), (90, True, False)])
    events = switches({1: wan1, 2: wan2})
    assert [(e.time, e.from_ids, e.to_ids) for e in events] == [(at(30), (1,), (2,)), (at(90), (2,), (1,))]


def test_switch_after_total_outage_counts_once():
    wan1 = series([(0, True, True), (30, False, False), (60, False, False)])
    wan2 = series([(0, False, False), (30, False, False), (60, True, True)])
    assert [(e.from_ids, e.to_ids) for e in switches({1: wan1, 2: wan2})] == [((1,), (2,))]


# --- kontroler UniFi ------------------------------------------------------------------------------


def test_gateway_wan_from_fixture():
    devices = parse_devices(json.loads((FIXTURES / "unifi_devices.json").read_text(encoding="utf-8")))
    gateway = next(d for d in devices if d.type == "udm")
    # Starsze odpowiedzi nie mają `ifname`: port 5 (uplink) to eth4 – WAN UCG Ultra
    assert gateway.wans == (WanPort("eth4", True, True),)
    assert all(d.wans == () for d in devices if d.type != "udm")


def test_gateway_dual_wan_failover():
    raw = {
        "type": "udm",
        "port_table": [
            {"port_idx": 4, "ifname": "eth3", "up": True, "is_uplink": False, "network_name": "wan2"},
            {"port_idx": 5, "ifname": "eth4", "up": True, "is_uplink": False, "network_name": "wan"},
        ],
        "wan1": {"ifname": "eth4", "up": False, "enable": True},
        "wan2": {"ifname": "eth3", "up": True, "enable": True},
        "uplink": {"name": "eth3", "up": True, "type": "wire"},
    }
    assert parse_wans(raw) == (WanPort("eth3", True, True), WanPort("eth4", False, False))
    assert parse_wans({"type": "usw", "port_table": raw["port_table"]}) == ()
    # Wyłączone łącze w ustawieniach UniFi nie jest WAN-em
    assert parse_wans({"type": "udm", "wan2": {"ifname": "eth3", "enable": False, "up": False}}) == ()
