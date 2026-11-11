"""Port idzie za nazwą przy przesunięciu numerów ifIndex (netpulse/ifindex.py)."""

from datetime import UTC, datetime, timedelta

from netpulse.ifindex import KnownPort, plan

NOW = datetime(2026, 11, 7, 23, 20, tzinfo=UTC)

# UCG Ultra na UniFi OS 5.1.33 (fixture ucg-ultra) i po aktualizacji do 6.0.17 (prawdziwy odczyt 11.11.2026)
BEFORE = {1: "lo", 2: "dummy0", 3: "ip_vti0", 4: "ip6_vti0", 5: "ip6tnl0", 6: "miireg", 7: "bond0", 8: "eth4",
          9: "switch0", 10: "ifb0", 11: "ifb1", 12: "eth0", 13: "eth1", 14: "eth2", 15: "eth3", 16: "switch0.1", 17: "br0"}
AFTER = {1: "lo", 2: "dummy0", 3: "ip_vti0", 4: "ip6_vti0", 5: "ip6tnl0", 6: "miireg", 7: "eth4", 8: "switch0",
         9: "eth0", 10: "eth1", 11: "eth2", 12: "eth3", 13: "switch0.1", 14: "br0", 15: "wgsrv1", 16: "wgsrv2"}


def known(mapping, extra=()):
    # id wiersza = numer, pod którym port był zapisany (jak w bazie użytkownika)
    return [KnownPort(idx, idx, name, NOW) for idx, name in mapping.items()] + list(extra)


def test_unchanged_numbering_moves_nothing():
    assert not plan(known(BEFORE), BEFORE)


def test_ucg_ultra_6_renumbering_follows_names():
    # wgsrv1/wgsrv2 były już wcześniej, pod wyższymi numerami (między sesjami VPN)
    extra = [KnownPort(90497, 18, "wgsrv1", NOW - timedelta(days=1)), KnownPort(408185, 21, "wgsrv2", NOW)]
    rows = known(BEFORE, extra)
    result = plan(rows, AFTER)
    final = {result.moves.get(r.id, r.if_index): r for r in rows if r.id not in result.parked}
    # Pod każdym odczytanym numerem stoi wiersz z tą samą nazwą (historia, łącza WAN i widgety idą za portem)
    for idx, name in AFTER.items():
        assert final[idx].name == name, (idx, name)
    assert result.moves[8] == 7  # eth4 (WAN 1) z 8 na 7
    assert result.moves[15] == 12  # eth3 (WAN 2, GSM) z 15 na 12
    # bond0, ifb0, ifb1 zniknęły, a ich numery zajęły inne porty – odstawione
    assert set(result.parked) == {7, 10, 11}
    assert result.moves[17] == 14  # br0 z 17 na 14 (numer 17 zostaje wolny)


def test_rename_without_renumbering_keeps_row():
    # Ten sam numer, nowa nazwa (np. firmware zmienił ifName) – nadal ten sam port
    assert not plan(known({1: "0/1", 2: "0/2"}), {1: "Port 1", 2: "Port 2"})


def test_swapped_ports():
    result = plan(known({1: "eth0", 2: "eth1"}), {1: "eth1", 2: "eth0"})
    assert result.moves == {1: 2, 2: 1} and result.parked == ()


def test_ambiguous_and_empty_names_are_not_matched():
    # "port" jest w odczycie dwa razy – nie wiadomo, który to dawny port 1; "x" jest jednoznaczne
    result = plan(known({1: "port", 2: "x"}), {1: "x", 2: "port", 3: "port"})
    assert result.moves == {2: 1} and result.parked == (1,)
    assert not plan(known({1: "", 2: "a"}), {2: "", 5: ""})


def test_parked_port_comes_back_to_its_row():
    rows = [KnownPort(1, 1, "eth0", NOW), KnownPort(7, -7, "bond0", NOW - timedelta(hours=1))]
    result = plan(rows, {1: "eth0", 2: "bond0"})
    assert result.moves == {7: 2} and result.parked == ()


def test_prefers_freshest_row_with_the_same_name():
    rows = [KnownPort(17, 17, "br0", NOW - timedelta(days=3)), KnownPort(40, 40, "br0", NOW)]
    assert plan(rows, {14: "br0"}).moves == {40: 14}
