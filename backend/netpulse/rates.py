"""Liczenie przyrostów i przepływności z liczników SNMP."""

from __future__ import annotations

from collections.abc import Hashable

_WRAP_32 = 2**32
_WRAP_64 = 2**64

# Porty Ethernet (ethernetCsmacd, fastEther, gigabitEthernet …): fizycznie nie przeniosą więcej niż wynegocjowana prędkość,
# więc odrzucamy już ponad 1,1× (od 0.54.4 – wcześniej 2×; routery UniFi potrafią raz na jakiś czas „dogonić” liczniki
# i pokazać 1–2 Gb/s na łączu 1 Gb/s). Inne interfejsy (mosty, VLAN, WiFi) często podają prędkość umowną – tam 2×.
ETHERNET_IF_TYPES = frozenset({6, 62, 69, 117})
ETHERNET_RATE_FACTOR = 1.1
DEFAULT_RATE_FACTOR = 2.0


def rate_factor(if_type: int | None) -> float:
    """Ile razy szybciej od prędkości łącza może być odczyt, zanim uznamy go za błąd licznika."""
    return ETHERNET_RATE_FACTOR if if_type in ETHERNET_IF_TYPES else DEFAULT_RATE_FACTOR


def counter_delta(prev: int, curr: int, bits: int = 64) -> int | None:
    """Przyrost licznika z obsługą przepełnienia.

    - curr >= prev: zwykły przyrost
    - Counter32 przekroczył 2^32: liczymy przez zawinięcie, jeśli prev był w górnej połowie
    - w pozostałych przypadkach (Counter64 spadł, reset urządzenia) zwracamy None
    """
    if curr >= prev:
        return curr - prev
    if bits == 32 and prev >= _WRAP_32 // 2:
        return curr + _WRAP_32 - prev
    if bits == 64 and prev >= _WRAP_64 - 2**40:
        return curr + _WRAP_64 - prev
    return None


def wait_for_slot(now: float, interval: float) -> float:
    """Ile sekund do najbliższej wielokrotności `interval` na zegarze (od 0.71.0: odczyty o :00 i :30).

    Odczyty równo z siatką czasu sprawiają, że każda próbka 30 s leży w całości w jednym kubełku 5-minutowym
    (i godzinowym) – suma bajtów w kubełku jest wtedy dokładna, jak w statystykach UniFi."""
    if interval <= 0:
        return 0.0
    return interval - (now % interval)


def sample_times(prev_ts: float | None, ts: float, interval: float, max_split: int = 4) -> list[float]:
    """Chwile zapisu próbki z przedziału (`prev_ts`, `ts`] – środek przedziału (od 0.71.0).

    Szybkość z różnicy liczników opisuje cały przedział, więc należy do kubełka, w którym leży jego środek, a nie
    do chwili odczytu (z odczytem o 20:05:00 próbka 20:04:30–20:05:00 trafiała do kubełka 20:05). Po pominiętym
    odczycie (przedział 60–120 s) próbka dzieli się na części po jednym interwale – każda z tą samą szybkością –
    żeby bajty z obu stron granicy kubełka trafiły tam, gdzie płynęły. Dłuższa przerwa: jeden punkt w środku."""
    if prev_ts is None or ts <= prev_ts:
        return [ts]
    dt = ts - prev_ts
    n = round(dt / interval) if interval > 0 else 1
    if n < 1 or n > max_split:
        n = 1
    step = dt / n
    return [prev_ts + step * (k + 0.5) for k in range(n)]


class CounterTracker:
    """Pamięta ostatnie wartości liczników i zwraca przyrosty/szybkości."""

    def __init__(self) -> None:
        self._last: dict[Hashable, tuple[float, int]] = {}
        self._reset: set[Hashable] = set()
        self._rejected: set[Hashable] = set()

    def was_reset(self, key: Hashable) -> bool:
        """Czy ostatni odczyt tego licznika wykrył reset (licznik spadł)."""
        return key in self._reset

    def was_rejected(self, key: Hashable) -> bool:
        """Czy ostatnia szybkość tego licznika była niemożliwa (ponad prędkość łącza) i została odrzucona."""
        return key in self._rejected

    def update(self, key: Hashable, ts: float, value: int | None, bits: int = 64) -> tuple[int, float] | None:
        """Zwraca (przyrost, czas w sekundach) albo None przy pierwszym odczycie/resecie."""
        if value is None:
            return None
        prev = self._last.get(key)
        self._last[key] = (ts, value)
        if prev is None:
            return None
        prev_ts, prev_val = prev
        dt = ts - prev_ts
        if dt <= 0:
            return None
        delta = counter_delta(prev_val, value, bits)
        if delta is None:
            self._reset.add(key)
            return None
        self._reset.discard(key)
        return delta, dt

    def rate(self, key: Hashable, ts: float, value: int | None, bits: int = 64) -> float | None:
        """Szybkość w jednostkach/s."""
        res = self.update(key, ts, value, bits)
        if res is None:
            return None
        delta, dt = res
        return delta / dt

    def bps(
        self,
        key: Hashable,
        ts: float,
        octets: int | None,
        bits: int = 64,
        max_mbps: int | None = None,
        factor: float = DEFAULT_RATE_FACTOR,
    ) -> float | None:
        """Bity na sekundę z licznika oktetów; odrzuca wartości nierealne (> `factor` × prędkość łącza)."""
        r = self.rate(key, ts, octets, bits)
        self._rejected.discard(key)
        if r is None:
            return None
        bps = r * 8
        if max_mbps and bps > max_mbps * 1_000_000 * factor:
            self._rejected.add(key)
            return None
        return bps

    def forget(self, predicate) -> None:
        """Usuwa zapamiętane liczniki pasujące do predykatu (np. po restarcie urządzenia)."""
        for key in [k for k in self._last if predicate(k)]:
            del self._last[key]
            self._reset.discard(key)
            self._rejected.discard(key)


class LiveRateTracker:
    """Przepływność dla danych na żywo (co ~1,5 s, od 0.45.1).

    Część urządzeń (UniFi) odświeża liczniki SNMP co kilka sekund – przy częstych odczytach co drugi pokazywałby 0,
    a następny podwójną wartość. Szybkość liczymy więc od ostatniej *zmiany* licznika; dopóki licznik stoi krócej niż
    `hold_s`, zwracamy poprzednią szybkość, dłużej – 0 (port naprawdę nic nie przesyła)."""

    def __init__(self, hold_s: float = 6.0) -> None:
        self.hold_s = hold_s
        self._last: dict[Hashable, tuple[float, int, float | None]] = {}  # czas zmiany, wartość, ostatnia szybkość

    def bps(
        self, key: Hashable, ts: float, octets: int | None, bits: int = 64, max_mbps: int | None = None, factor: float = DEFAULT_RATE_FACTOR
    ) -> float | None:
        if octets is None:
            return None
        prev = self._last.get(key)
        if prev is None:
            self._last[key] = (ts, octets, None)
            return None
        changed_at, value, rate = prev
        if octets == value:
            if ts - changed_at < self.hold_s:
                return rate
            self._last[key] = (changed_at, value, 0.0)
            return 0.0
        delta = counter_delta(value, octets, bits)
        dt = ts - changed_at
        if delta is None or dt <= 0:
            self._last[key] = (ts, octets, None)  # reset urządzenia – zaczynamy od nowa
            return None
        bps = delta * 8 / dt
        if max_mbps and bps > max_mbps * 1_000_000 * factor:
            self._last[key] = (ts, octets, rate)
            return rate
        self._last[key] = (ts, octets, bps)
        return bps
