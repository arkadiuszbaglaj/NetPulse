"""Stan zadania aktualizacji w plikach (przetrwa restart usługi i API w trakcie aktualizacji)."""

from __future__ import annotations

import json
import os
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .config import Settings

PHASES = ["prepare", "backup", "fetch", "build", "start", "verify"]
MAX_LOG_LINE = 600
LOG_TAIL = 150


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # Zapis atomowy: odczyt z API nigdy nie trafia na połowicznie zapisany plik
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def idle_status() -> dict[str, Any]:
    return {
        "state": "idle",
        "phase": None,
        "phases": [],
        "started_at": None,
        "finished_at": None,
        "from_version": None,
        "to_version": None,
        "from_commit": None,
        "to_commit": None,
        "error": None,
        "note": None,
    }


def new_status(from_version: str | None = None, from_commit: str | None = None) -> dict[str, Any]:
    status = idle_status()
    status.update(
        state="running",
        phase=PHASES[0],
        phases=[{"id": p, "status": "pending"} for p in PHASES],
        started_at=now_iso(),
        from_version=from_version,
        from_commit=from_commit,
    )
    return status


def read_status(s: Settings) -> dict[str, Any]:
    return _read_json(s.state_dir / "status.json") or idle_status()


def write_status(s: Settings, status: dict[str, Any]) -> None:
    _write_json(s.state_dir / "status.json", status)


def read_check(s: Settings) -> dict[str, Any] | None:
    return _read_json(s.state_dir / "check.json")


def write_check(s: Settings, info: dict[str, Any]) -> None:
    _write_json(s.state_dir / "check.json", info)


def reset_log(s: Settings) -> None:
    s.state_dir.mkdir(parents=True, exist_ok=True)
    (s.state_dir / "log.txt").write_text("", encoding="utf-8")


def append_log(s: Settings, line: str) -> None:
    line = line.rstrip("\r\n")[:MAX_LOG_LINE]
    if not line:
        return
    with (s.state_dir / "log.txt").open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def log_tail(s: Settings, n: int = LOG_TAIL) -> list[str]:
    try:
        lines = (s.state_dir / "log.txt").read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []
    return lines[-n:]
