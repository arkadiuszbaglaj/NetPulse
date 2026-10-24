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
