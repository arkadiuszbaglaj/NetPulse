"""Logowanie, kreator pierwszego konta, zmiana hasła, logowanie dwuskładnikowe (TOTP, od 0.63.0)."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select, text

from .. import __version__, audit, totp
from ..auth import hash_password, hash_token, needs_rehash, password_error, username_error, verify_password
from ..db import Session
from ..db.models import AuthSession, User
from .schemas import AuthStatus, Credentials, LoginBody, PasswordChange, UserOut
from .security import (
    CurrentUser,
    clear_session_cookie,
    client_ip,
    login_limiter,
    session_token,
    set_session_cookie,
    start_session,
    user_from_request,
)

router = APIRouter(prefix="/api/auth", tags=["logowanie"])

# Stała blokada (pg_advisory_xact_lock), żeby dwa równoczesne kreatory nie założyły dwóch adminów
_SETUP_LOCK = 0x4E50_0001

# Odpowiedzi logowania z drugim składnikiem: `code` czyta panel (pokazuje pole kodu), `message` to komunikat
TOTP_REQUIRED = {"code": "totp_required", "message": "Podaj kod z aplikacji uwierzytelniającej"}
TOTP_INVALID = {"code": "totp_invalid", "message": "Nieprawidłowy kod – spróbuj ponownie albo użyj kodu zapasowego"}


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
        version=__version__ if user is not None else None,  # numer wersji tylko po zalogowaniu (od 0.65.6)
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
        user = User(username=body.username, password_hash=hash_password(body.password))
        user.set_role("admin")
        session.add(user)
        await session.flush()
        await session.refresh(user)  # created_at nadaje baza
        token = await start_session(session, user, request)
    set_session_cookie(response, request, token)
    await audit.record("setup", user=user, ip=client_ip(request))
    return user


def check_second_factor(user: User, code: str) -> str | None:
    """Sprawdza kod TOTP albo kod zapasowy i zapisuje jego użycie na `user` (kod działa raz).

    Zwraca "totp", "recovery" albo None (zły kod)."""
    if user.totp_secret and not totp.looks_like_recovery(code):
        step = totp.verify(user.totp_secret, code, last_step=user.totp_last_step)
        if step is not None:
            user.totp_last_step = step
            return "totp"
    rest = totp.use_recovery(list(user.totp_recovery or []), code)
    if rest is not None:
        user.totp_recovery = rest
        return "recovery"
    return None


def clear_totp(user: User) -> None:
    user.totp_secret = None
    user.totp_enabled = False
    user.totp_last_step = None
    user.totp_recovery = None


@router.post("/login", response_model=UserOut)
async def login(body: LoginBody, request: Request, response: Response):
    ip = client_ip(request)
    if wait := login_limiter.retry_after(ip):
        raise HTTPException(
            429, f"Za dużo nieudanych prób. Spróbuj za {wait // 60 + 1} min.", headers={"Retry-After": str(wait)}
        )
    factor = None
    async with Session() as session, session.begin():
        user = await session.scalar(select(User).where(User.username == body.username))
        failed = not verify_password(user.password_hash if user else None, body.password)
        if not failed and user.totp_enabled:
            if not body.code:
                # Hasło dobre – panel dopyta o kod (to nie jest nieudana próba)
                raise HTTPException(401, TOTP_REQUIRED)
            factor = check_second_factor(user, body.code)
        if not failed and (factor is not None or not user.totp_enabled):
            if needs_rehash(user.password_hash):
                user.password_hash = hash_password(body.password)
            token = await start_session(session, user, request)
    if failed:
        login_limiter.failure(ip)
        await audit.record("login_failed", username=body.username, ip=ip, detail=None if user else "nieznany login")
        raise HTTPException(401, "Nieprawidłowy login lub hasło")
    if user.totp_enabled and factor is None:
        login_limiter.failure(ip)
        await audit.record("login_failed", user=user, ip=ip, detail="zły kod 2FA")
        raise HTTPException(401, TOTP_INVALID)
    login_limiter.success(ip)
    set_session_cookie(response, request, token)
    if factor == "recovery":
        detail = f"kod zapasowy (zostało {len(user.totp_recovery or [])})"
    else:
        detail = "2FA" if factor else None
    await audit.record("login", user=user, ip=ip, detail=detail)
    return user


@router.post("/logout", status_code=204)
async def logout(request: Request, response: Response):
    user = await user_from_request(request)
    if token := session_token(request):
        async with Session() as session, session.begin():
            await session.execute(delete(AuthSession).where(AuthSession.token_hash == hash_token(token)))
    clear_session_cookie(response, request)
    if user is not None:
        await audit.record("logout", user=user, ip=client_ip(request))


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
        current = hash_token(session_token(request) or "")
        await session.execute(
            delete(AuthSession).where(AuthSession.user_id == user.id, AuthSession.token_hash != current)
        )
    await audit.record("password", user=user, ip=client_ip(request))


# --- logowanie dwuskładnikowe (własne konto) -------------------------------------------------------------


class TotpStatus(BaseModel):
    enabled: bool
    pending: bool  # sekret wygenerowany, ale jeszcze niepotwierdzony kodem
    recovery_left: int


class PasswordOnly(BaseModel):
    password: str = Field(min_length=1, max_length=256)


class CodeOnly(BaseModel):
    code: str = Field(min_length=1, max_length=32)


class PasswordAndCode(BaseModel):
    password: str = Field(min_length=1, max_length=256)
    code: str = Field(min_length=1, max_length=32)


class TotpSetup(BaseModel):
    secret: str
    uri: str
    qr_svg: str


class RecoveryCodes(BaseModel):
    recovery_codes: list[str]


def _status(user: User) -> TotpStatus:
    return TotpStatus(
        enabled=user.totp_enabled,
        pending=bool(user.totp_secret) and not user.totp_enabled,
        recovery_left=len(user.totp_recovery or []) if user.totp_enabled else 0,
    )


async def _locked(session, user: User) -> User:
    db_user = await session.get(User, user.id, with_for_update=True)
    if db_user is None:
        raise HTTPException(401, "Sesja wygasła")
    return db_user


def _require_password(user: User, password: str) -> None:
    if not verify_password(user.password_hash, password):
        raise HTTPException(403, "Hasło jest nieprawidłowe")


@router.get("/totp", response_model=TotpStatus)
async def totp_status(user: CurrentUser):
    return _status(user)


@router.post("/totp/setup", response_model=TotpSetup)
async def totp_setup(body: PasswordOnly, user: CurrentUser):
    """Krok 1: nowy sekret (kod QR do aplikacji). Logowanie zmieni się dopiero po potwierdzeniu kodem."""
    async with Session() as session, session.begin():
        db_user = await _locked(session, user)
        _require_password(db_user, body.password)
        if db_user.totp_enabled:
            raise HTTPException(409, "Logowanie dwuskładnikowe jest już włączone")
        secret = totp.new_secret()
        db_user.totp_secret = secret
        db_user.totp_last_step = None
    uri = totp.otpauth_uri(secret, user.username)
    return TotpSetup(secret=secret, uri=uri, qr_svg=totp.qr_svg(uri))


@router.post("/totp/enable", response_model=RecoveryCodes)
async def totp_enable(body: CodeOnly, request: Request, user: CurrentUser):
    """Krok 2: kod z aplikacji potwierdza konfigurację; zwraca kody zapasowe (pokazywane tylko raz)."""
    async with Session() as session, session.begin():
        db_user = await _locked(session, user)
        if db_user.totp_enabled:
            raise HTTPException(409, "Logowanie dwuskładnikowe jest już włączone")
        if not db_user.totp_secret:
            raise HTTPException(409, "Najpierw wygeneruj kod QR")
        step = totp.verify(db_user.totp_secret, body.code)
        if step is None:
            raise HTTPException(422, "Nieprawidłowy kod – sprawdź czas w telefonie i spróbuj ponownie")
        codes = totp.new_recovery_codes()
        db_user.totp_enabled = True
        db_user.totp_last_step = step
        db_user.totp_recovery = [totp.hash_recovery(c) for c in codes]
        # Pozostałe sesje tego konta logują się od nowa – już z kodem
        current = hash_token(session_token(request) or "")
        await session.execute(
            delete(AuthSession).where(AuthSession.user_id == user.id, AuthSession.token_hash != current)
        )
    await audit.record("totp_enable", user=user, ip=client_ip(request))
    return RecoveryCodes(recovery_codes=codes)


@router.post("/totp/disable", response_model=TotpStatus)
async def totp_disable(body: PasswordAndCode, request: Request, user: CurrentUser):
    async with Session() as session, session.begin():
        db_user = await _locked(session, user)
        _require_password(db_user, body.password)
        if not db_user.totp_enabled:
            raise HTTPException(409, "Logowanie dwuskładnikowe nie jest włączone")
        if check_second_factor(db_user, body.code) is None:
            raise HTTPException(403, "Nieprawidłowy kod")
        clear_totp(db_user)
        result = _status(db_user)
    await audit.record("totp_disable", user=user, ip=client_ip(request))
    return result


@router.post("/totp/recovery", response_model=RecoveryCodes)
async def totp_new_recovery(body: PasswordAndCode, request: Request, user: CurrentUser):
    """Nowe kody zapasowe (stare przestają działać)."""
    async with Session() as session, session.begin():
        db_user = await _locked(session, user)
        _require_password(db_user, body.password)
        if not db_user.totp_enabled:
            raise HTTPException(409, "Logowanie dwuskładnikowe nie jest włączone")
        if check_second_factor(db_user, body.code) is None:
            raise HTTPException(403, "Nieprawidłowy kod")
        codes = totp.new_recovery_codes()
        db_user.totp_recovery = [totp.hash_recovery(c) for c in codes]
    await audit.record("totp_recovery", user=user, ip=client_ip(request))
    return RecoveryCodes(recovery_codes=codes)
