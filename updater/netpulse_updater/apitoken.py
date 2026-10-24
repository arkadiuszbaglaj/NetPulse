"""Token do rozmowy API ↔ updater: generowany przy pierwszym starcie, przechowywany we wspólnym
wolumenie Dockera (nie w `.env`, więc nie ma wartości domyślnej do odgadnięcia ani sekretu do wycieku z pliku)."""

from __future__ import annotations

import os
import secrets
from pathlib import Path

from .config import Settings


def ensure_token(s: Settings) -> Settings:
    """Zwraca ustawienia z tokenem: z `token`, z istniejącego pliku albo świeżo wygenerowanego.
    Przy wyłączonej usłudze (`enabled=False`) token jest pusty, więc wszystkie żądania są odrzucane."""
    if not s.enabled:
        return _with(s, "")
    if s.token:
        return s
    if not s.token_file:
        return s
    path = Path(s.token_file)
    try:
        existing = path.read_text(encoding="utf-8").strip()
    except OSError:
        existing = ""
    if len(existing) >= 32:
        return _with(s, existing)
    token = secrets.token_urlsafe(32)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(token)
    if hasattr(os, "chown"):  # nie ma na Windowsie (testy lokalne)
        try:
            os.chown(tmp, s.token_uid, s.token_uid)
        except OSError:
            os.chmod(tmp, 0o644)  # bez uprawnień do zmiany właściciela: czytelny dla API, ale tylko w wolumenie
    os.replace(tmp, path)
    return _with(s, token)


def _with(s: Settings, token: str) -> Settings:
    from dataclasses import replace

    return replace(s, token=token)
