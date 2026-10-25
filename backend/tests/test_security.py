"""Hasła, tokeny, CSRF, limit logowań, walidacja danych urządzeń – bez bazy."""

import asyncio

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from starlette.requests import Request

from netpulse.api.schemas import DeviceCreate, DeviceUpdate, credential_error
from netpulse.api.security import LoginLimiter, check_origin
from netpulse.auth import hash_password, hash_token, password_error, username_error, verify_password


def test_password_hash_roundtrip():
    h = hash_password("tajne-haslo")
    assert h.startswith("$argon2")
    assert verify_password(h, "tajne-haslo")
    assert not verify_password(h, "zle-haslo")
    assert not verify_password(None, "cokolwiek")
    assert not verify_password("to-nie-jest-hash", "x")


def test_token_hash_is_stable_and_not_token():
    assert hash_token("abc") == hash_token("abc")
    assert hash_token("abc") != "abc" and len(hash_token("abc")) == 64


def test_username_and_password_rules():
    assert username_error("admin") is None
    assert username_error("ja.nowak_1-x") is None
    assert username_error("") and username_error("z spacją") and username_error("a" * 65)
    assert password_error("1234567890") is None
    assert password_error("krotkie")


def _request(method: str, headers: dict[str, str]) -> Request:
    raw = [(k.lower().encode(), v.encode()) for k, v in headers.items()]
    return Request({"type": "http", "method": method, "headers": raw, "path": "/api/x", "query_string": b""})


@pytest.mark.parametrize(
    ("method", "headers", "ok"),
    [
        ("GET", {"host": "srv:8080", "origin": "http://evil:3000"}, True),  # odczyt – bez sprawdzania
        ("POST", {"host": "srv:8080"}, True),  # curl/skrypt – bez Origin
        ("POST", {"host": "srv:8080", "origin": "http://srv:8080"}, True),
        ("POST", {"host": "srv:8080", "origin": "http://srv:3000"}, False),  # inna aplikacja, ten sam serwer
        ("DELETE", {"host": "srv:8080", "origin": "http://evil.example"}, False),
        ("POST", {"host": "srv:8080", "origin": "null"}, False),
        ("PATCH", {"host": "srv:8080", "referer": "http://srv:8080/devices"}, True),
        ("PATCH", {"host": "srv:8080", "referer": "http://evil/x"}, False),
        ("POST", {"host": "127.0.0.1:8000", "x-forwarded-host": "netpulse.lan", "origin": "https://netpulse.lan"}, True),
    ],
)
def test_check_origin(method, headers, ok):
    request = _request(method, headers)
    if ok:
        asyncio.run(check_origin(request))
    else:
        with pytest.raises(HTTPException) as exc:
            asyncio.run(check_origin(request))
        assert exc.value.status_code == 403


def test_login_limiter_blocks_and_expires():
    lim = LoginLimiter(max_failures=3, window_s=60)
    for t in (0, 1, 2):
        assert lim.retry_after("ip", now=t) is None
        lim.failure("ip", now=t)
    assert lim.retry_after("ip", now=3) == 57
    assert lim.retry_after("inny", now=3) is None
    assert lim.retry_after("ip", now=61) is None  # najstarsza porażka wypadła z okna
    lim.failure("ip", now=62)
    lim.success("ip")
    assert lim.retry_after("ip", now=63) is None


def test_device_create_validation():
    d = DeviceCreate(name="Switch", host=" 192.168.1.2 ")
    assert d.host == "192.168.1.2" and d.community == "public" and d.credential_error() is None
    assert DeviceCreate(name="x", host="switch.lan").host == "switch.lan"
    with pytest.raises(ValidationError):
        DeviceCreate(name="x", host="nie ma; takiego")
    with pytest.raises(ValidationError):
        DeviceCreate(name="x", host="10.0.0.1", snmp_version="4")
    with pytest.raises(ValidationError):
        DeviceUpdate(host="zły host!")


def test_credential_rules():
    assert credential_error("2c", "public", None, None, None, None, None) is None
    assert credential_error("2c", None, None, None, None, None, None)
    assert credential_error("3", None, None, None, None, None, None)  # brak użytkownika
    assert credential_error("3", None, "mon", None, None, None, None) is None  # noAuthNoPriv
    assert credential_error("3", None, "mon", "SHA", "authpass1", "AES", "privpass1") is None
    assert credential_error("3", None, "mon", "SHA", None, None, None)  # protokół bez klucza
    assert credential_error("3", None, "mon", None, None, "AES", "privpass1")  # priv bez auth
    assert credential_error("3", None, "mon", "SHA", "krotki", None, None)  # klucz < 8 znaków
