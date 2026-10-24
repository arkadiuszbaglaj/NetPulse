"""REST API NetPulse (FastAPI).

Wszystko poza /api/health i /api/auth/{status,setup,login} wymaga zalogowania
(ciasteczko sesji). Pierwsze konto administratora zakłada kreator: POST /api/auth/setup.
Dokumentacja interaktywna: http://<serwer>:8000/docs
"""

from __future__ import annotations

from fastapi import Depends, FastAPI
from sqlalchemy import text

from .. import __version__
from ..db import engine, has_timescale
from . import auth_routes, devices, metrics
from .security import check_origin

app = FastAPI(title="NetPulse API", version=__version__, dependencies=[Depends(check_origin)])
app.include_router(auth_routes.router)
app.include_router(devices.router)
app.include_router(metrics.router)


@app.get("/api/health", tags=["system"])
async def health() -> dict:
    async with engine.connect() as conn:
        await conn.execute(text("SELECT 1"))
        timescale = await has_timescale(conn)
    return {"status": "ok", "version": __version__, "timescaledb": timescale}


__all__ = ["app"]
