"""Hasła i tokeny sesji – wspólne dla API i CLI."""

from __future__ import annotations

import hashlib
import re
import secrets

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

_hasher = PasswordHasher()
# Do porównania, gdy użytkownik nie istnieje – ten sam czas odpowiedzi co przy złym haśle
_DUMMY_HASH = _hasher.hash(secrets.token_hex(16))

USERNAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
MIN_PASSWORD = 8


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password_hash: str | None, password: str) -> bool:
    try:
        return _hasher.verify(password_hash or _DUMMY_HASH, password) and password_hash is not None
    except (VerificationError, InvalidHashError):
        return False


def needs_rehash(password_hash: str) -> bool:
    return _hasher.check_needs_rehash(password_hash)


def username_error(username: str) -> str | None:
    if not USERNAME_RE.match(username):
        return "Login: 1–64 znaki, litery, cyfry oraz . _ -"
    return None


def password_error(password: str) -> str | None:
    if len(password) < MIN_PASSWORD:
        return f"Hasło musi mieć co najmniej {MIN_PASSWORD} znaków"
    if len(password) > 256:
        return "Hasło może mieć najwyżej 256 znaków"
    return None


def new_token() -> str:
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()
