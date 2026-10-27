"""REST API NetPulse (FastAPI).

Wszystko poza /api/health i /api/auth/{status,setup,login} wymaga zalogowania
(ciasteczko sesji). Wyjątki: agenci serwerów (/api/agent/v1/report) logują się tokenem, a pulpity publiczne
(/api/public/dashboards/<token>) mają własne API tylko do odczytu z białą listą danych (public.py). Pierwsze konto administratora zakłada kreator: POST /api/auth/setup.
Dokumentacja interaktywna: http://<serwer>:8000/docs
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from sqlalchemy import text

from .. import __version__
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
    live,
    metrics,
    modules_api,
    notifications,
    panels,
    preferences,
    proxmox,
    public,
    servers,
    system,
    topology,
    updates,
    wan,
)
from .security import check_origin
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
app.include_router(devices.router)
app.include_router(live.router)
app.include_router(metrics.router)
app.include_router(modules_api.router)
app.include_router(notifications.router)
app.include_router(panels.router)
app.include_router(preferences.router)
app.include_router(proxmox.router)
app.include_router(public.router)
app.include_router(servers.router)
app.include_router(system.router)
app.include_router(topology.router)
app.include_router(updates.router)
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
