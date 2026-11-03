"""Liczenie przyrostów i przepływności z liczników SNMP."""

from __future__ import annotations

from collections.abc import Hashable

_WRAP_32 = 2**32
_WRAP_64 = 2**64


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


class CounterTracker:
    """Pamięta ostatnie wartości liczników i zwraca przyrosty/szybkości."""

    def __init__(self) -> None:
        self._last: dict[Hashable, tuple[float, int]] = {}

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
            return None
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
    ) -> float | None:
        """Bity na sekundę z licznika oktetów; odrzuca wartości nierealne (> 2x prędkości łącza)."""
        r = self.rate(key, ts, octets, bits)
        if r is None:
            return None
        bps = r * 8
        if max_mbps and bps > max_mbps * 1_000_000 * 2:
            return None
        return bps

    def forget(self, predicate) -> None:
        """Usuwa zapamiętane liczniki pasujące do predykatu (np. po restarcie urządzenia)."""
        for key in [k for k in self._last if predicate(k)]:
            del self._last[key]


class LiveRateTracker:
    """Przepływność dla danych na żywo (co ~1,5 s, od 0.45.1).

    Część urządzeń (UniFi) odświeża liczniki SNMP co kilka sekund – przy częstych odczytach co drugi pokazywałby 0,
    a następny podwójną wartość. Szybkość liczymy więc od ostatniej *zmiany* licznika; dopóki licznik stoi krócej niż
    `hold_s`, zwracamy poprzednią szybkość, dłużej – 0 (port naprawdę nic nie przesyła)."""

    def __init__(self, hold_s: float = 6.0) -> None:
        self.hold_s = hold_s
        self._last: dict[Hashable, tuple[float, int, float | None]] = {}  # czas zmiany, wartość, ostatnia szybkość

    def bps(self, key: Hashable, ts: float, octets: int | None, bits: int = 64, max_mbps: int | None = None) -> float | None:
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
        if max_mbps and bps > max_mbps * 1_000_000 * 2:
            self._last[key] = (ts, octets, rate)
            return rate
        self._last[key] = (ts, octets, bps)
        return bps
