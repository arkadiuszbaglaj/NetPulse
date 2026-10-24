"""Logowanie, kreator pierwszego konta, zmiana hasła."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, Response
from sqlalchemy import delete, func, select, text

from .. import __version__
from ..auth import hash_password, hash_token, needs_rehash, password_error, username_error, verify_password
from ..db import Session
from ..db.models import AuthSession, User
from .schemas import AuthStatus, Credentials, PasswordChange, UserOut
from .security import (
    COOKIE,
    CurrentUser,
    clear_session_cookie,
    client_ip,
    login_limiter,
    set_session_cookie,
    start_session,
    user_from_request,
)

router = APIRouter(prefix="/api/auth", tags=["logowanie"])

# Stała blokada (pg_advisory_xact_lock), żeby dwa równoczesne kreatory nie założyły dwóch adminów
_SETUP_LOCK = 0x4E50_0001


async def _user_count(session) -> int:
    return await session.scalar(select(func.count()).select_from(User)) or 0


@router.get("/status", response_model=AuthStatus)
async def status(request: Request, response: Response):
    """Czy trzeba założyć pierwsze konto i czy użytkownik jest zalogowany (publiczne)."""
    async with Session() as session:
        setup_required = await _user_count(session) == 0
    user = None if setup_required else await user_from_request(request, response)
    return AuthStatus(
        setup_required=setup_required,
        authenticated=user is not None,
        user=UserOut.model_validate(user) if user else None,
        version=__version__,
    )


@router.post("/setup", response_model=UserOut, status_code=201)
async def setup(body: Credentials, request: Request, response: Response):
    """Kreator: zakłada pierwsze konto administratora i od razu loguje. Działa tylko raz."""
    if err := username_error(body.username) or password_error(body.password):
        raise HTTPException(422, err)
    async with Session() as session, session.begin():
        await session.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": _SETUP_LOCK})
        if await _user_count(session) > 0:
            raise HTTPException(409, "Konto administratora już istnieje – zaloguj się")
        user = User(username=body.username, password_hash=hash_password(body.password), is_admin=True)
        session.add(user)
        await session.flush()
        await session.refresh(user)  # created_at nadaje baza
        token = await start_session(session, user, request)
    set_session_cookie(response, request, token)
    return user


@router.post("/login", response_model=UserOut)
async def login(body: Credentials, request: Request, response: Response):
    ip = client_ip(request)
    if wait := login_limiter.retry_after(ip):
        raise HTTPException(
            429, f"Za dużo nieudanych prób. Spróbuj za {wait // 60 + 1} min.", headers={"Retry-After": str(wait)}
        )
    async with Session() as session, session.begin():
        user = await session.scalar(select(User).where(User.username == body.username))
        if not verify_password(user.password_hash if user else None, body.password):
            login_limiter.failure(ip)
            raise HTTPException(401, "Nieprawidłowy login lub hasło")
        if needs_rehash(user.password_hash):
            user.password_hash = hash_password(body.password)
        token = await start_session(session, user, request)
    login_limiter.success(ip)
    set_session_cookie(response, request, token)
    return user


@router.post("/logout", status_code=204)
async def logout(request: Request, response: Response):
    if token := request.cookies.get(COOKIE):
        async with Session() as session, session.begin():
            await session.execute(delete(AuthSession).where(AuthSession.token_hash == hash_token(token)))
    clear_session_cookie(response)


@router.get("/me", response_model=UserOut)
async def me(user: CurrentUser):
    return user


@router.post("/password", status_code=204)
async def change_password(body: PasswordChange, request: Request, user: CurrentUser):
    """Zmiana własnego hasła. Wylogowuje pozostałe sesje tego użytkownika."""
    if err := password_error(body.new_password):
        raise HTTPException(422, err)
    async with Session() as session, session.begin():
        db_user = await session.get(User, user.id)
        if db_user is None or not verify_password(db_user.password_hash, body.current_password):
            raise HTTPException(403, "Obecne hasło jest nieprawidłowe")
        db_user.password_hash = hash_password(body.new_password)
        current = hash_token(request.cookies.get(COOKIE, ""))
        await session.execute(
            delete(AuthSession).where(AuthSession.user_id == user.id, AuthSession.token_hash != current)
        )
