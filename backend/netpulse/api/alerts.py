"""Alerty: reguły (CRUD), lista aktywnych i historii, potwierdzanie, licznik do dzwonka."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import func, select

from ..alerts import DEVICE_METRICS, METRICS
from ..db import Session
from ..db.models import Alert, AlertRule, Device
from .security import CurrentUser, require_user

router = APIRouter(prefix="/api", tags=["alerty"], dependencies=[Depends(require_user)])

Severity = Literal["info", "warning", "critical"]
Kind = Literal["device_offline", "port_down", "metric"]


class RuleBase(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    enabled: bool = True
    kind: Kind
    metric: str | None = None
    op: Literal[">", "<"] | None = None
    threshold: float | None = None
    duration_s: int = Field(0, ge=0, le=86400)
    severity: Severity = "warning"
    device_id: int | None = None

    @model_validator(mode="after")
    def _consistent(self):
        if self.kind == "metric":
            if self.metric not in METRICS:
                raise ValueError(f"Nieznana metryka; dostępne: {', '.join(METRICS)}")
            if self.op is None or self.threshold is None:
                raise ValueError("Reguła metryki wymaga warunku (op) i progu (threshold)")
            if self.metric not in DEVICE_METRICS and self.device_id is not None:
                raise ValueError("Ruch WAN jest sumą po routerach – nie wybieraj urządzenia")
        else:
            self.metric = self.op = self.threshold = None
        return self


class RuleCreate(RuleBase):
    pass


class RuleOut(RuleBase):
    model_config = ConfigDict(from_attributes=True)

    id: int
    created_at: datetime


class AlertOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    rule_id: int | None
    state: str
    severity: str
    title: str
    message: str | None
    device_id: int | None
    value: float | None
    peak: float | None
    started_at: datetime
    resolved_at: datetime | None
    acked_at: datetime | None
    acked_by: str | None


class AlertSummary(BaseModel):
    firing: int
    unacked: int
    critical: int
    warning: int
    info: int


# --- reguły ------------------------------------------------------------------


async def _check_device(session, device_id: int | None) -> None:
    if device_id is not None and await session.get(Device, device_id) is None:
        raise HTTPException(422, "Nie ma takiego urządzenia")


@router.get("/alert-rules", response_model=list[RuleOut])
async def list_rules():
    async with Session() as session:
        return (await session.scalars(select(AlertRule).order_by(AlertRule.id))).all()


@router.get("/alert-rules/metrics")
async def rule_metrics():
    """Metryki, na których można oprzeć regułę: nazwa, opis, jednostka i czy dotyczy pojedynczego urządzenia."""
    return [
        {"metric": m, "label": label, "unit": unit, "per_device": m in DEVICE_METRICS}
        for m, (label, unit) in METRICS.items()
    ]


@router.post("/alert-rules", response_model=RuleOut, status_code=201)
async def create_rule(body: RuleCreate):
    async with Session() as session, session.begin():
        await _check_device(session, body.device_id)
        rule = AlertRule(**body.model_dump())
        session.add(rule)
        await session.flush()
        await session.refresh(rule)
    return rule


@router.put("/alert-rules/{rule_id}", response_model=RuleOut)
async def update_rule(rule_id: int, body: RuleCreate):
    async with Session() as session, session.begin():
        rule = await session.get(AlertRule, rule_id)
        if rule is None:
            raise HTTPException(404, "Nie ma takiej reguły")
        await _check_device(session, body.device_id)
        for field, value in body.model_dump().items():
            setattr(rule, field, value)
    return rule


@router.delete("/alert-rules/{rule_id}", status_code=204)
async def delete_rule(rule_id: int):
    """Usuwa regułę; jej aktywne alerty kończą się przy najbliższej ocenie, a historia zostaje."""
    async with Session() as session, session.begin():
        rule = await session.get(AlertRule, rule_id)
        if rule is None:
            raise HTTPException(404, "Nie ma takiej reguły")
        await session.delete(rule)


# --- alerty ------------------------------------------------------------------


@router.get("/alerts", response_model=list[AlertOut])
async def list_alerts(
    state: Literal["firing", "resolved", "all"] = "firing",
    severity: Severity | None = None,
    device_id: int | None = None,
    limit: int = Query(100, ge=1, le=500),
):
    stmt = select(Alert).order_by(Alert.started_at.desc()).limit(limit)
    if state != "all":
        stmt = stmt.where(Alert.state == state)
    if severity:
        stmt = stmt.where(Alert.severity == severity)
    if device_id is not None:
        stmt = stmt.where(Alert.device_id == device_id)
    async with Session() as session:
        return (await session.scalars(stmt)).all()


@router.get("/alerts/summary", response_model=AlertSummary)
async def alerts_summary():
    """Liczniki aktywnych alertów (dzwonek w pasku górnym)."""
    async with Session() as session:
        rows = (
            await session.execute(
                select(Alert.severity, func.count(), func.count(Alert.id).filter(Alert.acked_at.is_(None)))
                .where(Alert.state == "firing")
                .group_by(Alert.severity)
            )
        ).all()
    counts = {sev: n for sev, n, _ in rows}
    return AlertSummary(
        firing=sum(counts.values()),
        unacked=sum(u for _, _, u in rows),
        critical=counts.get("critical", 0),
        warning=counts.get("warning", 0),
        info=counts.get("info", 0),
    )


@router.post("/alerts/{alert_id}/ack", response_model=AlertOut)
async def ack_alert(alert_id: int, user: CurrentUser):
    async with Session() as session, session.begin():
        alert = await session.get(Alert, alert_id)
        if alert is None:
            raise HTTPException(404, "Nie ma takiego alertu")
        if alert.acked_at is None:
            alert.acked_at, alert.acked_by = datetime.now(UTC), user.username
    return alert
