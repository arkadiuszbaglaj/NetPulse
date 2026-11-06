"""Dziennik audytu (od 0.61.0): kto, kiedy i skąd zalogował się albo zmienił konfigurację.

- logowanie, nieudane logowanie, wylogowanie, zmiana hasła, założenie konta – `record` w api/auth_routes.py,
- każda zmiana przez API (POST/PUT/PATCH/DELETE zalogowanego użytkownika, także odrzucona: 403, 422) –
  `middleware` w api/__init__.py; zapisujemy metodę, szablon trasy, konkretną ścieżkę i kod odpowiedzi,
  **bez treści żądania** (hasła, klucze API, community SNMP nie trafiają do dziennika).

Wpisy starsze niż `RETENTION` usuwa `record` przy okazji (najwyżej raz na godzinę).
"""

from __future__ import annotations

import logging
import time
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete

from .db import Session
from .db.models import AuditEntry, User

log = logging.getLogger(__name__)

RETENTION = timedelta(days=365)
_CLEANUP_EVERY_S = 3600
_last_cleanup = 0.0

# Trasy, których middleware nie zapisuje: logowanie ma własne wpisy, raport agenta i pulpit publiczny to nie konta
# panelu. Testy POST-em (SNMP, sprawdzenie) zapisujemy – łączą się z adresem podanym przez użytkownika.
SKIP_PREFIXES = ("/api/auth/", "/api/agent/", "/api/public/")


async def record(
    action: str,
    *,
    user: User | None = None,
    username: str | None = None,
    ip: str | None = None,
    target: str | None = None,
    status: int | None = None,
    detail: str | None = None,
) -> None:
    """Zapisuje wpis; błąd zapisu nie psuje obsługi żądania (tylko log)."""
    global _last_cleanup
    name = user.username if user else username
    try:
        now = datetime.now(UTC)
        async with Session() as session, session.begin():
            session.add(
                AuditEntry(
                    time=now,
                    user_id=user.id if user else None,
                    username=name[:64] if name else None,
                    ip=(ip or "")[:64] or None,
                    action=action[:96],
                    target=(target or "")[:255] or None,
                    status=status,
                    detail=(detail or "")[:255] or None,
                )
            )
            if time.monotonic() - _last_cleanup > _CLEANUP_EVERY_S:
                _last_cleanup = time.monotonic()
                await session.execute(delete(AuditEntry).where(AuditEntry.time < now - RETENTION))
    except Exception:  # noqa: BLE001 – dziennik nie może blokować panelu
        log.exception("Nie udało się zapisać wpisu dziennika audytu: %s", action)


def should_record(method: str, path: str) -> bool:
    return method in {"POST", "PUT", "PATCH", "DELETE"} and path.startswith("/api/") and not path.startswith(SKIP_PREFIXES)
