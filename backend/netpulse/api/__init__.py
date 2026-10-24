"""REST API NetPulse (FastAPI).

Wszystko poza /api/health i /api/auth/{status,setup,login} wymaga zalogowania
(ciasteczko sesji). Pierwsze konto administratora zakłada kreator: POST /api/auth/setup.
Dokumentacja interaktywna: http://<serwer>:8000/docs
"""

from __future__ import annotations

from fastapi import Depends, FastAPI
from sqlalchemy import text

from .. import __version__
from ..config import settings
from ..db import engine, has_timescale
from . import auth_routes, dashboard, dashboards, devices, metrics, preferences, updates
from .security import check_origin
from .web import mount_web

app = FastAPI(title="NetPulse API", version=__version__, dependencies=[Depends(check_origin)])
app.include_router(auth_routes.router)
app.include_router(dashboard.router)
app.include_router(dashboards.router)
app.include_router(devices.router)
app.include_router(metrics.router)
app.include_router(preferences.router)
app.include_router(updates.router)


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
