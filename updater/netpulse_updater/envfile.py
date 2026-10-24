"""Uzupełnianie deploy/.env o nowe zmienne z .env.example po aktualizacji (bez nadpisywania istniejących)."""

from __future__ import annotations

from pathlib import Path


def _keys(text: str) -> set[str]:
    keys = set()
    for line in text.splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            keys.add(line.split("=", 1)[0])
    return keys


def topup_env(install_dir: Path) -> list[str]:
    """Dopisuje do .env brakujące zmienne. Zwraca nazwy dopisanych (NETPULSE_DIR dostaje katalog tej instalacji)."""
    example = install_dir / "deploy" / ".env.example"
    env = install_dir / "deploy" / ".env"
    if not example.is_file() or not env.is_file():
        return []
    current = env.read_text(encoding="utf-8")
    have = _keys(current)
    added: list[str] = []
    lines: list[str] = []
    for line in example.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        if key in have:
            continue
        if key == "NETPULSE_DIR":
            value = str(install_dir)
        lines.append(f"{key}={value}")
        added.append(key)
    if lines:
        sep = "" if current.endswith("\n") or not current else "\n"
        env.write_text(current + sep + "\n".join(lines) + "\n", encoding="utf-8")
    return added
