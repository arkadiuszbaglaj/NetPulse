"""Logowanie dwuskładnikowe (od 0.63.0): kody TOTP (RFC 6238) i kody zapasowe – bez zewnętrznych bibliotek.

Aplikacje uwierzytelniające (Google Authenticator, Aegis, 1Password, Bitwarden…) używają domyślnie
SHA-1, 6 cyfr i 30 s – tak samo tutaj. Kod z sąsiedniego okna (±30 s) też przechodzi (zegar telefonu), ale każdy
krok czasu da się użyć tylko raz (`last_step`), więc podejrzany kod nie zaloguje drugi raz.

Kody zapasowe: 10 jednorazowych kodów `xxxx-xxxx` (alfabet bez 0/O/1/I/L); w bazie tylko skróty SHA-256.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import io
import secrets
import struct
import time
from urllib.parse import quote, urlencode

import segno

ISSUER = "NetPulse"
DIGITS = 6
PERIOD = 30
WINDOW = 1  # ile kroków w przód i w tył
RECOVERY_COUNT = 10
_RECOVERY_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz"


def new_secret() -> str:
    """Losowy sekret 160 bitów w base32 (bez `=`), jak w aplikacjach uwierzytelniających."""
    return base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")


def _key(secret: str) -> bytes:
    s = secret.strip().replace(" ", "").upper()
    return base64.b32decode(s + "=" * (-len(s) % 8))


def code_at(secret: str, step: int) -> str:
    digest = hmac.new(_key(secret), struct.pack(">Q", step), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    value = struct.unpack(">I", digest[offset : offset + 4])[0] & 0x7FFFFFFF
    return str(value % 10**DIGITS).zfill(DIGITS)


def current_step(now: float | None = None) -> int:
    return int((time.time() if now is None else now) // PERIOD)


def verify(secret: str, code: str, *, last_step: int | None = None, now: float | None = None) -> int | None:
    """Zwraca krok czasu pasującego kodu (do zapisania jako `last_step`) albo None."""
    code = "".join(ch for ch in code if ch.isdigit())
    if len(code) != DIGITS:
        return None
    step = current_step(now)
    for candidate in range(step - WINDOW, step + WINDOW + 1):
        if last_step is not None and candidate <= last_step:
            continue
        if hmac.compare_digest(code_at(secret, candidate), code):
            return candidate
    return None


def otpauth_uri(secret: str, username: str, issuer: str = ISSUER) -> str:
    label = quote(f"{issuer}:{username}")
    params = urlencode({"secret": secret, "issuer": issuer, "algorithm": "SHA1", "digits": DIGITS, "period": PERIOD})
    return f"otpauth://totp/{label}?{params}"


def qr_svg(uri: str) -> str:
    out = io.BytesIO()
    segno.make(uri, error="m").save(out, kind="svg", scale=5, border=2, xmldecl=False)
    return out.getvalue().decode()


def _normalize_recovery(code: str) -> str:
    return "".join(ch for ch in code.lower() if ch.isalnum())


def hash_recovery(code: str) -> str:
    return hashlib.sha256(_normalize_recovery(code).encode()).hexdigest()


def new_recovery_codes(count: int = RECOVERY_COUNT) -> list[str]:
    def one() -> str:
        raw = "".join(secrets.choice(_RECOVERY_ALPHABET) for _ in range(8))
        return f"{raw[:4]}-{raw[4:]}"

    return [one() for _ in range(count)]


def looks_like_recovery(code: str) -> bool:
    """Kod zapasowy ma litery albo 8 znaków; kod TOTP to same 6 cyfr."""
    norm = _normalize_recovery(code)
    return len(norm) == 8 and not (norm.isdigit() and len(norm) == DIGITS)


def use_recovery(hashes: list[str], code: str) -> list[str] | None:
    """Zwraca listę bez wykorzystanego kodu albo None, gdy kodu nie ma."""
    h = hash_recovery(code)
    for i, stored in enumerate(hashes):
        if hmac.compare_digest(stored, h):
            return hashes[:i] + hashes[i + 1 :]
    return None
