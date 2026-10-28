"""Pętla sprawdzeń dostępności (od 0.30.0) w procesie kolektora.

Co `TICK_S` wybiera włączone sprawdzenia, których czas (`interval_s`) minął, i wykonuje je równolegle (najwyżej
`MAX_PARALLEL` naraz). Wynik trafia do `check_metrics` (historia), a stan, czas zmiany stanu, ostatni błąd
i opóźnienie – do wiersza `checks` (lista w panelu, alerty).
"""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import UTC, datetime

from sqlalchemy import select

from .checks import CheckResult, run_check
from .collector import _write_with_retry
from .db import Session
from .db.models import Check, CheckMetric

log = logging.getLogger("netpulse.checks")

TICK_S = 5.0
MAX_PARALLEL = 20


class ChecksCollector:
    def __init__(self, runner=run_check) -> None:
        self.runner = runner
        self._last_run: dict[int, float] = {}  # id sprawdzenia → time.monotonic() ostatniego startu
        self._sem = asyncio.Semaphore(MAX_PARALLEL)

    async def run_forever(self) -> None:
        log.info("Sprawdzanie dostępności: start")
        while True:
            try:
                await self.tick()
            except Exception:
                log.exception("Błąd cyklu sprawdzeń dostępności")
            await asyncio.sleep(TICK_S)

    async def tick(self, now_mono: float | None = None) -> int:
        """Wykonuje sprawdzenia, na które przyszła pora; zwraca ich liczbę."""
        now_mono = time.monotonic() if now_mono is None else now_mono
        async with Session() as session:
            checks = (await session.scalars(select(Check).where(Check.enabled))).all()
        due = [c for c in checks if now_mono - self._last_run.get(c.id, -1e18) >= c.interval_s]
        for c in due:
            self._last_run[c.id] = now_mono
        known = {c.id for c in checks}
        self._last_run = {k: v for k, v in self._last_run.items() if k in known}
        if due:
            await asyncio.gather(*(self._one(c) for c in due))
        return len(due)

    async def _one(self, check: Check) -> None:
        async with self._sem:
            result = await self.runner(
                check.kind, check.target, port=check.port, timeout=check.timeout_s, expect=check.expect_status,
                keyword=check.keyword, verify_tls=check.verify_tls,
            )  # fmt: skip
        await save_result(check.id, result, datetime.now(UTC))


async def save_result(check_id: int, result: CheckResult, now: datetime) -> None:
    async def write(session) -> None:
        check = await session.get(Check, check_id, with_for_update=True)
        if check is None:  # usunięte w trakcie sprawdzania
            return
        status = "up" if result.up else "down"
        if status != check.status:
            if check.status != "unknown":
                log.info("%s (%s): %s → %s %s", check.name, check.target, check.status, status, result.error or "")
            check.status, check.status_since = status, now
        check.last_checked_at = now
        check.last_latency_ms = result.latency_ms
        check.last_error = (result.error or None) and result.error[:255]
        if result.up:
            check.last_ok_at = now
        session.add(
            CheckMetric(
                time=now, check_id=check.id, up=result.up, latency_ms=result.latency_ms, loss_percent=result.loss_percent,
                jitter_ms=result.jitter_ms, status_code=result.status_code, cert_days=result.cert_days,
            )
        )  # fmt: skip

    # Równoległe zapisy pierwszych wyników dnia zakładają ten sam chunk Timescale – możliwy deadlock, ponawiamy
    await _write_with_retry(write)
