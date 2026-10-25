"""Alerty: ocena reguł po każdym cyklu kolektora.

Stan trzymamy w bazie (tabela `alerts`), nie w pamięci, więc restart kolektora niczego nie gubi.
Wyzwolony alert żyje, dopóki warunek jest spełniony; potem przechodzi w „zakończony”. Alerty dla
usuniętych albo wyłączonych reguł są kończone przy najbliższej ocenie."""

from __future__ import annotations

import logging
from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select

from .config import settings
from .db import Session
from .db.models import Alert, AlertRule, Device, DeviceMetric, Interface, InterfaceMetric

log = logging.getLogger("netpulse.alerts")

SEVERITIES = ("info", "warning", "critical")
KINDS = ("device_offline", "port_down", "metric")
OPS = (">", "<")

# Metryki reguł typu „metric”: nazwa → (opis, jednostka). Pierwsze trzy są per urządzenie, WAN to suma po routerach.
METRICS: dict[str, tuple[str, str]] = {
    "cpu_percent": ("CPU", "%"),
    "mem_used_percent": ("RAM", "%"),
    "load1": ("Obciążenie (1 min)", ""),
    "wan_in_bps": ("Pobieranie WAN", "b/s"),
    "wan_out_bps": ("Wysyłanie WAN", "b/s"),
}
DEVICE_METRICS = ("cpu_percent", "mem_used_percent", "load1")

DEFAULT_RULES = (
    dict(name="Urządzenie nie odpowiada", kind="device_offline", duration_s=120, severity="critical"),
    dict(name="Port przeszedł w stan down", kind="port_down", duration_s=0, severity="warning"),
)


def breaches(op: str, value: float | None, threshold: float) -> bool:
    if value is None:
        return False
    return value > threshold if op == ">" else value < threshold


def sustained(
    samples: list[tuple[datetime, float | None]], now: datetime, duration_s: int, op: str, threshold: float, interval_s: float
) -> bool:
    """Czy warunek trwa nieprzerwanie od `duration_s`? Próbki od najstarszej; potrzebne pokrycie całego okna,
    żeby świeżo dodane urządzenie albo luka w danych nie dawały fałszywych alarmów."""
    if not samples:
        return False
    samples = sorted(samples, key=lambda s: s[0])
    if not breaches(op, samples[-1][1], threshold):
        return False
    if duration_s <= 0:
        return True
    start = now - timedelta(seconds=duration_s)
    window = [s for s in samples if s[0] >= start - timedelta(seconds=interval_s)]
    if not window or window[0][0] > start + timedelta(seconds=interval_s * 1.5):
        return False  # dane zaczynają się później niż początek okna
    return all(breaches(op, v, threshold) for t, v in window if t >= start)


def format_value(metric: str, value: float) -> str:
    unit = METRICS[metric][1]
    if unit == "b/s":
        for suffix, div in (("Gb/s", 1e9), ("Mb/s", 1e6), ("kb/s", 1e3)):
            if abs(value) >= div:
                return f"{value / div:.1f} {suffix}".replace(".", ",")
        return f"{value:.0f} b/s"
    return f"{value:.1f}{unit}".replace(".", ",")


@dataclass
class Hit:
    """Podmiot, dla którego warunek reguły jest teraz spełniony."""

    subject: str
    title: str
    message: str | None
    device_id: int | None
    value: float | None


class AlertEngine:
    def __init__(self, now_fn=lambda: datetime.now(UTC)) -> None:
        self.now_fn = now_fn

    async def ensure_default_rules(self) -> None:
        """Przy pierwszym uruchomieniu (brak reguł i historii) dodaje reguły „offline” i „port down”."""
        async with Session() as session, session.begin():
            has_rules = await session.scalar(select(func.count()).select_from(AlertRule))
            has_alerts = await session.scalar(select(func.count()).select_from(Alert))
            if not has_rules and not has_alerts:
                session.add_all(AlertRule(**r) for r in DEFAULT_RULES)

    async def evaluate(self) -> None:
        now = self.now_fn()
        async with Session() as session, session.begin():
            rules = (await session.scalars(select(AlertRule).where(AlertRule.enabled))).all()
            devices = {d.id: d for d in (await session.scalars(select(Device).where(Device.enabled))).all()}
            firing = (await session.scalars(select(Alert).where(Alert.state == "firing"))).all()
            by_key = {(a.rule_id, a.subject): a for a in firing}
            active_rules = {r.id for r in rules}

            seen: set[tuple[int | None, str]] = set()
            for rule in rules:
                for hit in await self._hits(session, rule, devices, now):
                    key = (rule.id, hit.subject)
                    seen.add(key)
                    alert = by_key.get(key)
                    if alert is None:
                        session.add(
                            Alert(
                                rule_id=rule.id,
                                subject=hit.subject,
                                state="firing",
                                severity=rule.severity,
                                title=hit.title,
                                message=hit.message,
                                device_id=hit.device_id,
                                value=hit.value,
                                peak=hit.value,
                                started_at=now,
                            )
                        )
                        log.info("ALERT: %s", hit.title)
                    else:
                        alert.value = hit.value
                        alert.message = hit.message
                        if hit.value is not None:
                            peaks = [p for p in (alert.peak, hit.value) if p is not None]
                            alert.peak = max(peaks) if rule.op != "<" else min(peaks)

            for key, alert in by_key.items():
                if key not in seen or alert.rule_id not in active_rules:
                    alert.state = "resolved"
                    alert.resolved_at = now
                    log.info("Alert zakończony: %s", alert.title)

    # --- rodzaje reguł ----------------------------------------------------------------

    async def _hits(self, session, rule: AlertRule, devices: dict[int, Device], now: datetime) -> list[Hit]:
        scope = [d for d in devices.values() if rule.device_id in (None, d.id)]
        if rule.kind == "device_offline":
            return self._offline(rule, scope, now)
        if rule.kind == "port_down":
            return await self._port_down(session, rule, scope, now)
        if rule.kind == "metric" and rule.metric in METRICS and rule.op in OPS and rule.threshold is not None:
            return await self._metric(session, rule, scope, now)
        return []

    def _offline(self, rule: AlertRule, scope: list[Device], now: datetime) -> list[Hit]:
        hits = []
        for d in scope:
            if d.status != "down":
                continue
            since = d.last_ok_at or d.created_at
            offline_s = (now - since).total_seconds() if since else 0
            if offline_s >= rule.duration_s:
                hits.append(Hit(f"d{d.id}", f"{d.name} nie odpowiada", d.last_error, d.id, offline_s))
        return hits

    async def _port_down(self, session, rule: AlertRule, scope: list[Device], now: datetime) -> list[Hit]:
        """Port, który jeszcze przed chwilą działał, a teraz jest down (puste porty nie dają alertu).
        Alert trwa, dopóki port nie wróci; gdy urządzenie przestaje odpowiadać, mówi o tym alert „offline”."""
        up = {d.id: d for d in scope if d.status == "up"}
        if not up:
            return []
        since = now - timedelta(seconds=settings.poll_interval * 3 + 30)
        rows = (
            await session.execute(
                select(InterfaceMetric.interface_id, InterfaceMetric.oper_up)
                .join(Interface, Interface.id == InterfaceMetric.interface_id)
                .where(Interface.device_id.in_(up), Interface.hidden.is_(False), InterfaceMetric.time >= since)
                .order_by(InterfaceMetric.interface_id, InterfaceMetric.time.desc())
            )
        ).all()
        recent: dict[int, list[bool | None]] = defaultdict(list)
        for iface_id, oper_up in rows:
            recent[iface_id].append(oper_up)
        already = {
            a.subject for a in (await session.scalars(select(Alert).where(Alert.rule_id == rule.id, Alert.state == "firing"))).all()
        }
        interfaces = {
            i.id: i for i in (await session.scalars(select(Interface).where(Interface.id.in_(list(recent) or [0])))).all()
        }
        hits = []
        for iface_id, states in recent.items():
            if states[0] is not False:
                continue
            went_down = len(states) > 1 and states[1] is True
            if not (went_down or f"i{iface_id}" in already):
                continue
            iface = interfaces[iface_id]
            device = up[iface.device_id]
            label = iface.alias or iface.label or iface.name
            hits.append(Hit(f"i{iface_id}", f"Port {label} ({device.name}) jest wyłączony", None, device.id, 0.0))
        return hits

    async def _metric(self, session, rule: AlertRule, scope: list[Device], now: datetime) -> list[Hit]:
        metric, op, threshold = rule.metric, rule.op, float(rule.threshold)
        interval = float(settings.poll_interval)
        since = now - timedelta(seconds=rule.duration_s + interval * 2)
        label = METRICS[metric][0]
        hits = []
        if metric in DEVICE_METRICS:
            column = getattr(DeviceMetric, metric)
            rows = (
                await session.execute(
                    select(DeviceMetric.device_id, DeviceMetric.time, column)
                    .where(DeviceMetric.device_id.in_([d.id for d in scope] or [0]), DeviceMetric.time >= since)
                    .order_by(DeviceMetric.device_id, DeviceMetric.time)
                )
            ).all()
            samples: dict[int, list[tuple[datetime, float | None]]] = defaultdict(list)
            for dev_id, t, v in rows:
                samples[dev_id].append((t, v))
            names = {d.id: d.name for d in scope}
            for dev_id, series in samples.items():
                if sustained(series, now, rule.duration_s, op, threshold, interval):
                    v = series[-1][1]
                    hits.append(
                        Hit(f"d{dev_id}", f"{names[dev_id]}: {label} {format_value(metric, v)}", self._detail(rule, metric), dev_id, v)
                    )
            return hits

        # WAN: suma po wszystkich interfejsach WAN włączonych routerów (w zakresie reguły)
        column = InterfaceMetric.in_bps if metric == "wan_in_bps" else InterfaceMetric.out_bps
        rows = (
            await session.execute(
                select(InterfaceMetric.time, func.sum(column))
                .join(Interface, Interface.id == InterfaceMetric.interface_id)
                .where(
                    Interface.role == "wan",
                    Interface.device_id.in_([d.id for d in scope] or [0]),
                    InterfaceMetric.time >= since,
                )
                .group_by(InterfaceMetric.time)
                .order_by(InterfaceMetric.time)
            )
        ).all()
        series = [(t, v) for t, v in rows]
        if sustained(series, now, rule.duration_s, op, threshold, interval):
            v = series[-1][1]
            hits.append(Hit("wan", f"{label} {format_value(metric, v)}", self._detail(rule, metric), rule.device_id, v))
        return hits

    @staticmethod
    def _detail(rule: AlertRule, metric: str) -> str:
        span = f" przez {rule.duration_s // 60} min" if rule.duration_s >= 60 else ""
        return f"Warunek: {METRICS[metric][0]} {rule.op} {format_value(metric, float(rule.threshold))}{span}"
