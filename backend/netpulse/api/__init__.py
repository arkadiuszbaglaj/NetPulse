"""REST API NetPulse (FastAPI).

Wszystko poza /api/health i /api/auth/{status,setup,login} wymaga zalogowania
(ciasteczko sesji). Wyjątki: agenci serwerów (/api/agent/v1/report) logują się tokenem, a pulpity publiczne
(/api/public/dashboards/<token>) mają własne API tylko do odczytu z białą listą danych (public.py). Pierwsze konto administratora zakłada kreator: POST /api/auth/setup.
Dokumentacja interaktywna: http://<serwer>:8000/docs
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Request
from sqlalchemy import text

from .. import __version__, audit
from ..config import settings
from ..db import engine, has_timescale
from . import (
    agents,
    alerts,
    auth_routes,
    availability,
    backups,
    checks,
    clients,
    controllers,
    dashboard,
    dashboards,
    devices,
    events,
    live,
    maintenance,
    metrics,
    modules_api,
    notifications,
    panels,
    preferences,
    proxmox,
    public,
    reports,
    servers,
    system,
    topology,
    updates,
    users,
    vpn,
    wan,
)
from . import (
    tls as tls_api,
)
from .security import check_origin, client_ip, route_template
from .web import mount_web


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Cykliczne sprawdzanie aktualizacji (jeśli włączone w ustawieniach), żeby panel mógł o nich przypomnieć
    task = asyncio.create_task(updates.auto_check_loop())
    try:
        yield
    finally:
        task.cancel()


app = FastAPI(title="NetPulse API", version=__version__, dependencies=[Depends(check_origin)], lifespan=lifespan)


@app.middleware("http")
async def audit_changes(request: Request, call_next):
    """Dziennik audytu: każda zmiana zalogowanego użytkownika (też odrzucona) – bez treści żądania (audit.py)."""
    response = await call_next(request)
    if audit.should_record(request.method, request.url.path):
        user = getattr(request.state, "user", None)
        if user is not None:
            await audit.record(
                f"{request.method} {route_template(request)}",
                user=user,
                ip=client_ip(request),
                target=request.url.path,
                status=response.status_code,
            )
    return response
app.include_router(agents.admin_router)
app.include_router(agents.push_router)
app.include_router(alerts.router)
app.include_router(auth_routes.router)
app.include_router(availability.router)
app.include_router(backups.router)
app.include_router(checks.router)
app.include_router(clients.router)
app.include_router(controllers.router)
app.include_router(dashboard.router)
app.include_router(dashboards.router)
app.include_router(events.router)
app.include_router(devices.router)
app.include_router(live.router)
app.include_router(maintenance.router)
app.include_router(metrics.router)
app.include_router(modules_api.router)
app.include_router(notifications.router)
app.include_router(panels.router)
app.include_router(preferences.router)
app.include_router(proxmox.router)
app.include_router(public.router)
app.include_router(reports.router)
app.include_router(servers.router)
app.include_router(system.router)
app.include_router(tls_api.router)
app.include_router(topology.router)
app.include_router(updates.router)
app.include_router(users.router)
app.include_router(vpn.router)
app.include_router(wan.router)


@app.get("/api/health", tags=["system"])
async def health() -> dict:
    async with engine.connect() as conn:
        await conn.execute(text("SELECT 1"))
        timescale = await has_timescale(conn)
    return {"status": "ok", "version": __version__, "timescaledb": timescale}


# Panel (frontend/dist) – na końcu, żeby nie przesłaniał tras API. W obrazie Dockera NETPULSE_WEB_DIR=/app/web
if settings.web_dir:
    mount_web(app, settings.web_dir)


__all__ = ["app"]
