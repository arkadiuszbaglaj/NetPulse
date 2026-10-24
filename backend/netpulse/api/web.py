"""Serwowanie zbudowanego panelu (frontend/dist) z tego samego procesu co API."""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.types import Scope

NO_CACHE = {"Cache-Control": "no-cache"}
IMMUTABLE = "public, max-age=31536000, immutable"


class _HashedAssets(StaticFiles):
    """Pliki z /assets mają skrót w nazwie, więc przeglądarka może je trzymać bez końca."""

    async def get_response(self, path: str, scope: Scope) -> Response:
        response = await super().get_response(path, scope)
        if response.status_code == 200:
            response.headers["Cache-Control"] = IMMUTABLE
        return response


def mount_web(app: FastAPI, web_dir: str | Path) -> bool:
    """Podłącza panel pod `/`. Zwraca False, gdy katalogu nie ma (np. development bez builda).

    Trasy API i dokumentacja (/api, /docs, /openapi.json) zarejestrowane wcześniej mają pierwszeństwo.
    Każdy inny adres bez pliku dostaje index.html – routing aplikacji działa po stronie przeglądarki.
    """
    root = Path(web_dir).resolve()
    index = root / "index.html"
    if not index.is_file():
        return False

    if (root / "assets").is_dir():
        app.mount("/assets", _HashedAssets(directory=root / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    async def panel(path: str) -> FileResponse:
        if path == "api" or path.startswith("api/"):
            raise HTTPException(404, "Not Found")  # nieistniejący endpoint API – JSON, nie strona panelu
        candidate = (root / path).resolve()
        if path and candidate.is_file() and root in candidate.parents:
            return FileResponse(candidate, headers=NO_CACHE)
        return FileResponse(index, headers=NO_CACHE)

    return True
