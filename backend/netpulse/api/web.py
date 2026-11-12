"""Serwowanie zbudowanego panelu (frontend/dist) z tego samego procesu co API."""

from __future__ import annotations

import base64
import hashlib
import mimetypes
import re
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.types import Scope

mimetypes.add_type("application/manifest+json", ".webmanifest")  # nie każdy system zna to rozszerzenie

NO_CACHE = {"Cache-Control": "no-cache"}
IMMUTABLE = "public, max-age=31536000, immutable"


_INLINE_SCRIPT = re.compile(r"<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>", re.DOTALL | re.IGNORECASE)


def inline_script_hashes(html: str) -> list[str]:
    """Skróty CSP (`'sha256-…'`) skryptów wpisanych wprost w stronę – w panelu to jeden: ustawienie motywu przed
    pierwszym renderem. Liczone ze zbudowanego index.html, więc zmiana skryptu nie wymaga zmiany nagłówka."""
    return [
        "'sha256-" + base64.b64encode(hashlib.sha256(body.encode("utf-8")).digest()).decode() + "'"
        for body in _INLINE_SCRIPT.findall(html)
        if body.strip()
    ]


def content_security_policy(script_hashes: list[str] | tuple[str, ...] = ()) -> str:
    """Pełna polityka treści panelu (od 0.68.0): wszystko z własnego adresu, skrypty tylko z plików panelu i wskazane
    skróty skryptów w stronie. Ogranicza skutki ewentualnego XSS – wstrzyknięty skrypt się nie wykona, a dane nie
    wyjdą na obcy serwer. Style w atrybutach (`'unsafe-inline'`) są potrzebne wykresom i siatce pulpitu."""
    return "; ".join(
        [
            "default-src 'self'",
            " ".join(["script-src 'self'", *script_hashes]),
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob:",
            "font-src 'self' data:",
            "connect-src 'self'",  # API i WebSocket „Na żywo” pod tym samym adresem
            "worker-src 'self' blob:",
            "manifest-src 'self'",
            "frame-ancestors 'self'",
            "base-uri 'self'",
            "object-src 'none'",
            "form-action 'self'",
        ]
    )


def panel_script_hashes(web_dir: str | Path) -> list[str]:
    """Skróty skryptów z index.html zbudowanego panelu; pusta lista, gdy panelu nie ma."""
    try:
        return inline_script_hashes((Path(web_dir) / "index.html").read_text(encoding="utf-8"))
    except OSError:
        return []


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
