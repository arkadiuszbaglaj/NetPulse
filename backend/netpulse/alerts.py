"""Alerty: ocena reguł po każdym cyklu kolektora.

Stan trzymamy w bazie (tabela `alerts`), nie w pamięci, więc restart kolektora niczego nie gubi.
Wyzwolony alert żyje, dopóki warunek jest spełniony; potem przechodzi w „zakończony”. Alerty dla
usuniętych albo wyłączonych reguł są kończone przy najbliższej ocenie."""

from __future__ import annotations

import hashlib
import logging
from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from fnmatch import fnmatchcase

from sqlalchemy import func, select

from .config import settings
from .db import Session
from .db.models import (
    Alert,
    AlertRule,
    AppSetting,
    Device,
    DeviceMetric,
    DiskMetric,
    Interface,
    InterfaceMetric,
    Metric,
    SystemMetric,
)
from .notifications import AlertEvent, Notifier

log = logging.getLogger("netpulse.alerts")

SEVERITIES = ("info", "warning", "critical")
# Rodzaje na ogólnej tabeli `metrics`: z agenta (kontener, usługa systemd, SMART) i z Proxmoxa (maszyna, kopia)
AGENT_KINDS = ("container_stopped", "service_failed", "smart_failed", "guest_stopped", "backup_failed")
KINDS = ("device_offline", "port_down", "metric", *AGENT_KINDS)
OPS = (">", "<")

# Metryki reguł typu „metric”: nazwa → (opis, jednostka). Pierwsze trzy są per urządzenie, WAN to suma po routerach.
METRICS: dict[str, tuple[str, str]] = {
    "cpu_percent": ("CPU", "%"),
    "mem_used_percent": ("RAM", "%"),
    "load1": ("Obciążenie (1 min)", ""),
    "wan_in_bps": ("Pobieranie WAN", "b/s"),
    "wan_out_bps": ("Wysyłanie WAN", "b/s"),
    "disk_used_percent": ("Zajętość dysku (każda partycja serwera)", "%"),
    "port_errors": ("Błędy na porcie (w jednym cyklu odczytu)", ""),
    "system_cpu_percent": ("Serwer NetPulse: CPU", "%"),
    "system_mem_used_percent": ("Serwer NetPulse: RAM", "%"),
    "system_disk_used_percent": ("Serwer NetPulse: dysk", "%"),
    "temp_c": ("Temperatura (każdy czujnik serwera z agentem)", "°C"),
    "smart_reallocated": ("SMART: realokowane sektory (każdy dysk serwera z agentem)", ""),
    "backup_age_h": ("Proxmox: godziny od ostatniej kopii (każda VM i LXC)", " h"),
}
DEVICE_METRICS = ("cpu_percent", "mem_used_percent", "load1")
DISK_METRICS = ("disk_used_percent",)
PORT_METRICS = ("port_errors",)
# Metryki serwera, na którym działa NetPulse → kolumna w `system_metrics`
SYSTEM_METRICS = {
    "system_cpu_percent": "cpu_percent",
    "system_mem_used_percent": "mem_used_percent",
    "system_disk_used_percent": "disk_used_percent",
}
# Metryki z agenta: nazwa reguły → nazwa w tabeli `metrics` (jeden alert na klucz, np. czujnik albo dysk)
AGENT_METRICS = {"temp_c": "temp_c", "smart_reallocated": "smart_reallocated", "backup_age_h": "backup_age_h"}
# Tytuł alertu progu z agenta/Proxmoxa: „<urządzenie>: <co> <klucz> <wartość>”
AGENT_METRIC_WHAT = {"temp_c": "temperatura", "smart_reallocated": "realokowane sektory", "backup_age_h": "ostatnia kopia"}
# Można je zawęzić do jednego urządzenia; pozostałe (WAN, serwer NetPulse) są globalne
PER_DEVICE_METRICS = DEVICE_METRICS + DISK_METRICS + PORT_METRICS + tuple(AGENT_METRICS)
# Reguły, które można zawęzić wzorcem nazwy (pole `match`)
MATCHABLE_METRICS = tuple(AGENT_METRICS)

# Rodzaj reguły z agenta → (metryka w `metrics`, co jest podmiotem, opis stanu w tytule alertu)
AGENT_STATES = {
    "container_stopped": ("container_up", "kontener", "zatrzymany"),
    "service_failed": ("service_up", "usługa", "nie działa"),
    "smart_failed": ("smart_ok", "dysk", "zgłasza błąd SMART"),
    "guest_stopped": ("guest_up", "maszyna", "zatrzymana"),
    "backup_failed": ("backup_task_ok", "kopia zapasowa", "zakończyła się błędem"),
}
# Bez filtru nazwy alarm tylko dla tych, które przed chwilą działały (zatrzymane od dawna są zamierzone)
WENT_DOWN_KINDS = ("container_stopped", "guest_stopped")

# Reguły domyślne w kolejnych wersjach. Instalacja dostaje każdy zestaw raz (znacznik w app_settings),
# więc reguła usunięta przez użytkownika nie wraca po restarcie.
DEFAULT_RULE_SETS = (
    (
        dict(name="Urządzenie nie odpowiada", kind="device_offline", duration_s=120, severity="critical"),
        dict(name="Port przeszedł w stan down", kind="port_down", duration_s=0, severity="warning"),
    ),
    (
        dict(name="Kontener zatrzymany", kind="container_stopped", duration_s=60, severity="warning"),
        dict(name="Usługa systemd nie działa", kind="service_failed", duration_s=60, severity="warning"),
        dict(name="SMART: dysk zgłasza błąd", kind="smart_failed", duration_s=0, severity="critical"),
        dict(name="Wysoka temperatura", kind="metric", metric="temp_c", op=">", threshold=85.0, duration_s=300, severity="warning"),
    ),
    (
        dict(name="Proxmox: maszyna zatrzymana", kind="guest_stopped", duration_s=60, severity="warning"),
        dict(name="Proxmox: kopia zapasowa nie powiodła się", kind="backup_failed", duration_s=0, severity="critical"),
        dict(name="Proxmox: brak świeżej kopii VM", kind="metric", metric="backup_age_h", op=">", threshold=36.0, duration_s=0, severity="warning"),
    ),
)
DEFAULTS_KEY = "alert_defaults"


def subject_key(prefix: str, key: str) -> str:
    """Podmiot alertu ma najwyżej 64 znaki; długie nazwy (kontenery, punkty montowania) skracamy skrótem."""
    full = f"{prefix}:{key}"
    return full if len(full) <= 64 else f"{prefix}:#{hashlib.sha1(key.encode()).hexdigest()[:16]}"


def matches(pattern: str | None, name: str) -> bool:
    """Filtr nazwy z reguły: pusty = wszystko, `*` i `?` jak w powłoce, bez rozróżniania wielkości liter.
    Usługę można podać bez `.service`."""
    if not pattern:
        return True
    name, pattern = name.lower(), pattern.strip().lower()
    return fnmatchcase(name, pattern) or fnmatchcase(name.removesuffix(".service"), pattern)


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
    if metric in ("port_errors", "smart_reallocated"):
        return f"{value:.0f}"
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
    def __init__(self, now_fn=lambda: datetime.now(UTC), notifier: Notifier | None = None) -> None:
        self.now_fn = now_fn
        self.notifier = notifier

    async def ensure_default_rules(self) -> None:
        """Dodaje zestawy reguł domyślnych, których ta instalacja jeszcze nie dostała.

        Nowa instalacja dostaje wszystkie. Instalacja sprzed znacznika (≤ 0.11) miała już pierwszy zestaw,
        o ile cokolwiek było skonfigurowane (reguły albo historia) – wtedy dochodzą tylko nowsze."""
        async with Session() as session, session.begin():
            marker = await session.get(AppSetting, DEFAULTS_KEY, with_for_update=True)
            if marker is not None:
                applied = int(marker.value.get("sets", 0))
            else:
                has_rules = await session.scalar(select(func.count()).select_from(AlertRule))
                has_alerts = await session.scalar(select(func.count()).select_from(Alert))
                applied = 1 if (has_rules or has_alerts) else 0
                marker = AppSetting(key=DEFAULTS_KEY, value={})
                session.add(marker)
            for rule_set in DEFAULT_RULE_SETS[applied:]:
                session.add_all(AlertRule(**r) for r in rule_set)
            marker.value = {"sets": len(DEFAULT_RULE_SETS)}
            marker.updated_at = datetime.now(UTC)

    async def evaluate(self) -> list[AlertEvent]:
        """Ocenia reguły, zapisuje zmiany stanu alertów, rozsyła powiadomienia i zwraca zdarzenia tego cyklu."""
        events = await self._evaluate()
        if self.notifier is not None and events:
            await self.notifier.send(events)
        return events

    async def _evaluate(self) -> list[AlertEvent]:
        now = self.now_fn()
        events: list[AlertEvent] = []
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
                        device = devices.get(hit.device_id) if hit.device_id is not None else None
                        events.append(
                            AlertEvent(
                                "firing", rule.severity, hit.title, hit.message, device.name if device else None, hit.value, now
                            )
                        )
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
                    device = devices.get(alert.device_id) if alert.device_id is not None else None
                    events.append(
                        AlertEvent(
                            "resolved", alert.severity, alert.title, None, device.name if device else None,
                            alert.value, alert.started_at, now,
                        )
                    )
        return events

    # --- rodzaje reguł ----------------------------------------------------------------

    async def _hits(self, session, rule: AlertRule, devices: dict[int, Device], now: datetime) -> list[Hit]:
        scope = [d for d in devices.values() if rule.device_id in (None, d.id)]
        if rule.kind == "device_offline":
            return self._offline(rule, scope, now)
        if rule.kind == "port_down":
            return await self._port_down(session, rule, scope, now)
        if rule.kind in AGENT_STATES:
            return await self._agent_state(session, rule, scope, now)
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

        if metric in DISK_METRICS:
            return await self._disk(session, rule, scope, since, now)
        if metric in PORT_METRICS:
            return await self._port_errors(session, rule, scope, since, now)
        if metric in SYSTEM_METRICS:
            return await self._system(session, rule, since, now)
        if metric in AGENT_METRICS:
            return await self._agent_metric(session, rule, scope, since, now)

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

    async def _disk(self, session, rule: AlertRule, scope: list[Device], since: datetime, now: datetime) -> list[Hit]:
        """Zajętość każdej partycji serwera osobno (alert na partycję), liczona z ostatnich próbek."""
        metric, op, threshold = rule.metric, rule.op, float(rule.threshold)
        rows = (
            await session.execute(
                select(DiskMetric.device_id, DiskMetric.mount, DiskMetric.time, DiskMetric.used_bytes, DiskMetric.total_bytes)
                .where(DiskMetric.device_id.in_([d.id for d in scope] or [0]), DiskMetric.time >= since)
                .order_by(DiskMetric.device_id, DiskMetric.mount, DiskMetric.time)
            )
        ).all()
        samples: dict[tuple[int, str], list[tuple[datetime, float | None]]] = defaultdict(list)
        for dev_id, mount, t, used, total in rows:
            samples[(dev_id, mount)].append((t, 100.0 * used / total if total else None))
        names = {d.id: d.name for d in scope}
        hits = []
        for (dev_id, mount), series in samples.items():
            if sustained(series, now, rule.duration_s, op, threshold, float(settings.poll_interval)):
                v = series[-1][1]
                title = f"{names[dev_id]}: dysk {mount} zajęty w {format_value(metric, v)}"
                hits.append(Hit(subject_key(f"d{dev_id}", mount), title, self._detail(rule, metric), dev_id, v))
        return hits

    async def _port_errors(
        self, session, rule: AlertRule, scope: list[Device], since: datetime, now: datetime
    ) -> list[Hit]:
        """Błędy wejścia i wyjścia na porcie w jednym cyklu odczytu (kolektor zapisuje przyrost)."""
        metric, op, threshold = rule.metric, rule.op, float(rule.threshold)
        rows = (
            await session.execute(
                select(InterfaceMetric.interface_id, InterfaceMetric.time, InterfaceMetric.in_errors, InterfaceMetric.out_errors)
                .join(Interface, Interface.id == InterfaceMetric.interface_id)
                .where(
                    Interface.device_id.in_([d.id for d in scope] or [0]),
                    Interface.hidden.is_(False),
                    InterfaceMetric.time >= since,
                )
                .order_by(InterfaceMetric.interface_id, InterfaceMetric.time)
            )
        ).all()
        samples: dict[int, list[tuple[datetime, float | None]]] = defaultdict(list)
        for iface_id, t, err_in, err_out in rows:
            both_missing = err_in is None and err_out is None  # pierwszy odczyt: nie ma jeszcze przyrostu
            samples[iface_id].append((t, None if both_missing else float((err_in or 0) + (err_out or 0))))
        if not samples:
            return []
        interfaces = {i.id: i for i in (await session.scalars(select(Interface).where(Interface.id.in_(list(samples))))).all()}
        names = {d.id: d.name for d in scope}
        hits = []
        for iface_id, series in samples.items():
            if sustained(series, now, rule.duration_s, op, threshold, float(settings.poll_interval)):
                iface = interfaces[iface_id]
                label = iface.alias or iface.label or iface.name
                v = series[-1][1]
                title = f"Błędy na porcie {label} ({names[iface.device_id]}): {format_value(metric, v)}"
                hits.append(Hit(f"i{iface_id}", title, self._detail(rule, metric), iface.device_id, v))
        return hits

    async def _system(self, session, rule: AlertRule, since: datetime, now: datetime) -> list[Hit]:
        """Serwer, na którym działa NetPulse (CPU, RAM, dysk): jeden alert na regułę."""
        metric, op, threshold = rule.metric, rule.op, float(rule.threshold)
        column = getattr(SystemMetric, SYSTEM_METRICS[metric])
        rows = (await session.execute(select(SystemMetric.time, column).where(SystemMetric.time >= since).order_by(SystemMetric.time))).all()
        series = [(t, v) for t, v in rows]
        if sustained(series, now, rule.duration_s, op, threshold, float(settings.poll_interval)):
            v = series[-1][1]
            return [Hit("system", f"{METRICS[metric][0]} {format_value(metric, v)}", self._detail(rule, metric), None, v)]
        return []

    async def _series(
        self, session, name: str, scope: list[Device], since: datetime, pattern: str | None
    ) -> dict[tuple[int, str], list[tuple[datetime, float | None]]]:
        """Próbki z ogólnej tabeli `metrics` (od najstarszej) na urządzenie i klucz, po filtrze nazwy."""
        rows = (
            await session.execute(
                select(Metric.device_id, Metric.key, Metric.time, Metric.value)
                .where(Metric.name == name, Metric.device_id.in_([d.id for d in scope] or [0]), Metric.time >= since)
                .order_by(Metric.device_id, Metric.key, Metric.time)
            )
        ).all()
        samples: dict[tuple[int, str], list[tuple[datetime, float | None]]] = defaultdict(list)
        for dev_id, key, t, v in rows:
            if matches(pattern, key):
                samples[(dev_id, key)].append((t, v))
        return samples

    async def _agent_metric(self, session, rule: AlertRule, scope: list[Device], since: datetime, now: datetime) -> list[Hit]:
        """Próg na metryce z agenta (temperatura czujnika, realokowane sektory dysku) – alert na klucz."""
        metric, op, threshold = rule.metric, rule.op, float(rule.threshold)
        names = {d.id: d.name for d in scope}
        hits = []
        for (dev_id, key), series in (await self._series(session, AGENT_METRICS[metric], scope, since, rule.match)).items():
            if sustained(series, now, rule.duration_s, op, threshold, float(settings.poll_interval)):
                v = series[-1][1]
                title = f"{names[dev_id]}: {AGENT_METRIC_WHAT[metric]} {key} {format_value(metric, v)}"
                hits.append(Hit(subject_key(f"d{dev_id}:{metric}", key), title, self._detail(rule, metric), dev_id, v))
        return hits

    async def _agent_state(self, session, rule: AlertRule, scope: list[Device], now: datetime) -> list[Hit]:
        """Kontener albo maszyna zatrzymana, usługa nie działa, SMART albo kopia zgłasza błąd (wartość 0 w `metrics`).

        Kontener i maszyna bez filtru nazwy alarmują tylko, jeśli przed chwilą działały: zatrzymane od dawna
        (np. jednorazowe zadania, zapasowe VM) nie dają alarmu. Z filtrem nazwy – zawsze, bo o nie chodzi."""
        name, what, state = AGENT_STATES[rule.kind]
        interval = float(settings.poll_interval)
        since = now - timedelta(seconds=rule.duration_s + interval * 3)
        already = {
            a.subject for a in (await session.scalars(select(Alert).where(Alert.rule_id == rule.id, Alert.state == "firing"))).all()
        }
        names = {d.id: d.name for d in scope}
        hits = []
        for (dev_id, key), series in (await self._series(session, name, scope, since, rule.match)).items():
            if not sustained(series, now, rule.duration_s, "<", 1.0, interval):
                continue
            subject = subject_key(f"d{dev_id}:{rule.kind[0]}", key)
            if rule.kind in WENT_DOWN_KINDS and not rule.match and subject not in already:
                if not any(v is not None and v >= 1 for _t, v in series):
                    continue
            label = key.removesuffix(".service") if rule.kind == "service_failed" else key
            hits.append(Hit(subject, f"{names[dev_id]}: {what} {label} {state}", self._state_detail(rule), dev_id, None))
        return hits

    @staticmethod
    def _state_detail(rule: AlertRule) -> str:
        span = f" od {rule.duration_s // 60} min" if rule.duration_s >= 60 else ""
        return f"Stan z agenta NetPulse{span}" + (f" (filtr: {rule.match})" if rule.match else "")

    @staticmethod
    def _detail(rule: AlertRule, metric: str) -> str:
        span = f" przez {rule.duration_s // 60} min" if rule.duration_s >= 60 else ""
        return f"Warunek: {METRICS[metric][0]} {rule.op} {format_value(metric, float(rule.threshold))}{span}"
