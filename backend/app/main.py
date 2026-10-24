import logging
from typing import Annotated

from fastapi import Depends, FastAPI
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app import __version__
from app.config import get_settings
from app.db import get_session

logging.basicConfig(level=get_settings().log_level)
log = logging.getLogger("netpulse")

app = FastAPI(title="NetPulse", version=__version__)

Session = Annotated[AsyncSession, Depends(get_session)]


@app.get("/api/health")
async def health(session: Session):
    """Liveness + database check. Returns 503 when the database is unreachable."""
    try:
        result = await session.execute(
            text("SELECT extversion FROM pg_extension WHERE extname = 'timescaledb'")
        )
        timescaledb = result.scalar_one_or_none()
    except Exception as exc:  # noqa: BLE001 - report any DB failure as unhealthy
        log.warning("Health check: database error: %s", exc)
        return JSONResponse(
            status_code=503,
            content={"status": "error", "version": __version__, "database": "unreachable"},
        )
    return {
        "status": "ok",
        "version": __version__,
        "database": "ok",
        "timescaledb": timescaledb,
    }
