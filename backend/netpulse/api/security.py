"""Sesje logowania, role kont, ochrona CSRF i limit prób logowania.

Role (od 0.61.0): zmiany (POST/PUT/PATCH/DELETE) robi tylko administrator, z wyjątkiem tras z `ROLE_RULES`
– tam wystarczy rola operatora albo podglądu. Nowa trasa zmieniająca dane jest więc domyślnie tylko dla
administratora; trasę dla innych ról trzeba dopisać tutaj świadomie."""

from __future__ import annotations

import time
from collections import defaultdict, deque
from datetime import UTC, datetime, timedelta
from typing import Annotated
from urllib.parse import urlsplit

from fastapi import Depends, HTTPException, Request, Response
from sqlalchemy import delete
from starlette.requests import HTTPConnection

from ..auth import hash_token, new_token
from ..config import settings
from ..db import Session
from ..db.models import AuthSession, User

COOKIE = "netpulse_session"
# Co ile przedłużać sesję przy aktywności (żeby nie pisać do bazy przy każdym żądaniu)
REFRESH_EVERY = timedelta(hours=1)
UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


def _session_ttl() -> timedelta:
    return timedelta(days=settings.session_days)


def client_ip(request: Request) -> str:
    return request.client.host if request.client else "?"


def set_session_cookie(response: Response, request: Request, token: str) -> None:
    response.set_cookie(
        COOKIE,
        token,
        max_age=int(_session_ttl().total_seconds()),
        httponly=True,
        samesite="lax",
        secure=request.url.scheme == "https",
        path="/",
    )


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(COOKIE, path="/")


async def start_session(session, user: User, request: Request) -> str:
    """Tworzy sesję w bazie (w transakcji wywołującego) i zwraca token do ciasteczka."""
    now = datetime.now(UTC)
    token = new_token()
    session.add(
        AuthSession(
            token_hash=hash_token(token),
            user_id=user.id,
            created_at=now,
            last_seen_at=now,
            expires_at=now + _session_ttl(),
            ip=client_ip(request)[:64],
            user_agent=(request.headers.get("user-agent") or "")[:255] or None,
        )
    )
    user.last_login_at = now
    # Sprzątanie wygasłych sesji przy okazji logowania
    await session.execute(delete(AuthSession).where(AuthSession.expires_at < now))
    return token


async def user_from_request(request: Request, response: Response | None = None) -> User | None:
    token = request.cookies.get(COOKIE)
    if not token:
        return None
    now = datetime.now(UTC)
    async with Session() as session, session.begin():
        auth = await session.get(AuthSession, hash_token(token))
        if auth is None or auth.expires_at <= now:
            return None
        user = await session.get(User, auth.user_id)
        if user is None:
            return None
        if now - auth.last_seen_at > REFRESH_EVERY:
            auth.last_seen_at = now
            auth.expires_at = now + _session_ttl()
            if response is not None:
                set_session_cookie(response, request, token)
        return user


RANK = {"viewer": 0, "operator": 1, "admin": 2}
# (metoda, szablon trasy) → najniższa rola, która może to zrobić; reszta zmian = administrator
ROLE_RULES: dict[tuple[str, str], str] = {
    # każdy: własne hasło, odświeżanie i własne pulpity (pulpity mają właściciela)
    ("POST", "/api/auth/password"): "viewer",
    ("PUT", "/api/preferences/refresh"): "viewer",
    ("PUT", "/api/dashboards/default"): "viewer",
    ("DELETE", "/api/dashboards/default"): "viewer",
    ("POST", "/api/dashboards"): "viewer",
    ("PATCH", "/api/dashboards/{dashboard_id}"): "viewer",
    ("DELETE", "/api/dashboards/{dashboard_id}"): "viewer",
    ("POST", "/api/dashboards/{dashboard_id}/default"): "viewer",
    # operator: obsługa bieżąca
    ("POST", "/api/alerts/{alert_id}/ack"): "operator",
    ("POST", "/api/maintenance"): "operator",
    ("PUT", "/api/maintenance/{window_id}"): "operator",
    ("DELETE", "/api/maintenance/{window_id}"): "operator",
}
ROLE_NAMES = {"admin": "administratora", "operator": "operatora", "viewer": "podglądu"}


def route_template(request: HTTPConnection) -> str:
    route = request.scope.get("route")
    return getattr(route, "path", None) or request.url.path


def required_role(method: str, template: str) -> str:
    if method not in UNSAFE_METHODS:
        return "viewer"
    return ROLE_RULES.get((method, template), "admin")


def has_role(user: User, role: str) -> bool:
    return RANK.get(user.role, 0) >= RANK[role]


async def require_user(request: Request, response: Response) -> User:
    """Zależność FastAPI: zalogowany użytkownik albo 401; zmiany zgodnie z rolą (ROLE_RULES) albo 403."""
    user = await user_from_request(request, response)
    if user is None:
        raise HTTPException(401, "Wymagane logowanie", headers={"WWW-Authenticate": "Cookie"})
    request.state.user = user
    need = required_role(request.method, route_template(request))
    if not has_role(user, need):
        raise HTTPException(403, f"Ta operacja wymaga uprawnień {ROLE_NAMES[need]}")
    return user


CurrentUser = Annotated[User, Depends(require_user)]


async def require_admin(user: CurrentUser) -> User:
    """Zależność FastAPI: tylko administrator – także odczyt (kopie zapasowe, konta, dziennik audytu)."""
    if user.role != "admin":
        raise HTTPException(403, "Ta operacja wymaga uprawnień administratora")
    return user


AdminUser = Annotated[User, Depends(require_admin)]


async def require_operator(user: CurrentUser) -> User:
    if not has_role(user, "operator"):
        raise HTTPException(403, "Ta operacja wymaga uprawnień operatora")
    return user


OperatorUser = Annotated[User, Depends(require_operator)]


def allowed_hosts(request: HTTPConnection) -> set[str]:
    hosts = {request.headers.get("host", "").lower()}
    if fwd := request.headers.get("x-forwarded-host"):
        hosts.add(fwd.split(",")[0].strip().lower())
    for origin in settings.trusted_origins.split(","):
        if origin.strip():
            hosts.add(urlsplit(origin.strip()).netloc.lower())
    hosts.discard("")
    return hosts


async def check_origin(request: HTTPConnection) -> None:
    """CSRF: zmiany (POST/PATCH/DELETE) tylko z tej samej strony.

    Przeglądarka zawsze dodaje Origin do żądań między stronami, więc obca strona
    (np. inna aplikacja w homelabie na innym porcie) nie wyśle nic w naszym imieniu.
    Klienci spoza przeglądarki (curl, skrypty) Origin nie wysyłają.
    """
    # WebSocket (brak metody) sprawdza Origin sam przy łączeniu – patrz api/live.py
    if getattr(request, "method", None) not in UNSAFE_METHODS:
        return
    origin = request.headers.get("origin") or request.headers.get("referer")
    if origin is None:
        return
    if origin == "null" or urlsplit(origin).netloc.lower() not in allowed_hosts(request):
        raise HTTPException(403, "Żądanie z innej strony odrzucone (CSRF)")


class LoginLimiter:
    """Prosty limit nieudanych logowań na adres IP (w pamięci procesu API)."""

    def __init__(self, max_failures: int = 10, window_s: float = 900) -> None:
        self.max_failures = max_failures
        self.window_s = window_s
        self._failures: dict[str, deque[float]] = defaultdict(deque)

    def _recent(self, key: str, now: float) -> deque[float]:
        q = self._failures[key]
        while q and now - q[0] > self.window_s:
            q.popleft()
        return q

    def retry_after(self, key: str, now: float | None = None) -> int | None:
        """Sekundy do odblokowania albo None, gdy można próbować."""
        now = time.monotonic() if now is None else now
        q = self._recent(key, now)
        if len(q) < self.max_failures:
            return None
        return max(1, int(self.window_s - (now - q[0])))

    def failure(self, key: str, now: float | None = None) -> None:
        now = time.monotonic() if now is None else now
        self._recent(key, now).append(now)

    def success(self, key: str) -> None:
        self._failures.pop(key, None)


login_limiter = LoginLimiter()
