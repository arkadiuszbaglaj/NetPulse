"""Nazwa ciasteczka sesji według protokołu (od 0.65.5): HTTP i HTTPS nie nadpisują sobie nawzajem sesji."""

from __future__ import annotations

from starlette.requests import Request
from starlette.responses import Response

from netpulse.api.security import (
    COOKIE,
    COOKIE_HTTP,
    clear_session_cookie,
    cookie_name,
    session_token,
    set_session_cookie,
)


def _request(scheme: str, cookies: dict[str, str] | None = None, kind: str = "http") -> Request:
    header = "; ".join(f"{k}={v}" for k, v in (cookies or {}).items())
    scope = {
        "type": kind,
        "scheme": scheme,
        "method": "GET",
        "path": "/",
        "headers": [(b"cookie", header.encode())] if header else [],
        "server": ("netpulse", 8080),
    }
    return Request(scope)


def test_cookie_name_by_scheme():
    assert cookie_name(_request("http")) == COOKIE_HTTP
    assert cookie_name(_request("https")) == COOKIE
    assert cookie_name(_request("wss")) == COOKIE
    assert cookie_name(_request("ws")) == COOKIE_HTTP


def test_set_cookie_http_is_not_secure_https_is_secure():
    r = Response()
    set_session_cookie(r, _request("http"), "abc")
    header = r.headers["set-cookie"]
    assert header.startswith(f"{COOKIE_HTTP}=abc") and "secure" not in header.lower()

    r = Response()
    set_session_cookie(r, _request("https"), "abc")
    header = r.headers["set-cookie"]
    assert header.startswith(f"{COOKIE}=abc") and "secure" in header.lower()


def test_session_token_prefers_own_scheme_and_falls_back():
    both = {COOKIE: "tls", COOKIE_HTTP: "plain"}
    assert session_token(_request("http", both)) == "plain"
    assert session_token(_request("https", both)) == "tls"
    # Sesja sprzed 0.65.5 albo aplikacja Android 0.2.0: `netpulse_session` przez HTTP
    assert session_token(_request("http", {COOKIE: "old"})) == "old"
    # HTTPS dostaje też ciasteczko z HTTP (bez Secure)
    assert session_token(_request("https", {COOKIE_HTTP: "plain"})) == "plain"
    assert session_token(_request("http")) is None


def test_clear_removes_both_names():
    r = Response()
    clear_session_cookie(r, _request("https"))
    headers = [v for k, v in r.raw_headers if k == b"set-cookie"]
    assert any(h.startswith(f"{COOKIE_HTTP}=".encode()) for h in headers)
    assert any(h.startswith(f"{COOKIE}=".encode()) and b"secure" in h.lower() for h in headers)
