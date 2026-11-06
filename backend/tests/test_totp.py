"""Kody TOTP (RFC 6238) i kody zapasowe – bez bazy."""

from __future__ import annotations

from urllib.parse import parse_qs, urlsplit

from netpulse import totp

# RFC 6238, dodatek B: sekret ASCII "12345678901234567890" (SHA-1); 6 ostatnich cyfr z 8-cyfrowych wektorów
RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
VECTORS = {59: "287082", 1111111109: "081804", 1111111111: "050471", 1234567890: "005924", 2000000000: "279037"}


def test_rfc6238_vectors():
    for t, code in VECTORS.items():
        assert totp.code_at(RFC_SECRET, totp.current_step(t)) == code


def test_verify_window_and_replay():
    now = 1234567890
    step = totp.current_step(now)
    code = totp.code_at(RFC_SECRET, step)
    assert totp.verify(RFC_SECRET, code, now=now) == step
    assert totp.verify(RFC_SECRET, "005 924", now=now) == step  # spacje z aplikacji
    # zegar telefonu o 30 s do tyłu / do przodu
    assert totp.verify(RFC_SECRET, totp.code_at(RFC_SECRET, step - 1), now=now) == step - 1
    assert totp.verify(RFC_SECRET, totp.code_at(RFC_SECRET, step + 1), now=now) == step + 1
    assert totp.verify(RFC_SECRET, totp.code_at(RFC_SECRET, step - 2), now=now) is None
    # ten sam kod drugi raz nie przechodzi
    assert totp.verify(RFC_SECRET, code, now=now, last_step=step) is None
    assert totp.verify(RFC_SECRET, "12345", now=now) is None
    assert totp.verify(RFC_SECRET, "abcdef", now=now) is None


def test_new_secret_and_uri():
    secret = totp.new_secret()
    assert len(secret) == 32 and "=" not in secret
    assert totp.code_at(secret, 1).isdigit()
    uri = totp.otpauth_uri(secret, "jan kowalski")
    parts = urlsplit(uri)
    assert parts.scheme == "otpauth" and parts.netloc == "totp" and parts.path == "/NetPulse%3Ajan%20kowalski"
    q = parse_qs(parts.query)
    assert q["secret"] == [secret] and q["issuer"] == ["NetPulse"] and q["digits"] == ["6"] and q["period"] == ["30"]
    assert totp.qr_svg(uri).startswith("<svg")


def test_recovery_codes_are_single_use():
    codes = totp.new_recovery_codes()
    assert len(codes) == 10 and len(set(codes)) == 10
    assert all(len(c) == 9 and c[4] == "-" for c in codes)
    hashes = [totp.hash_recovery(c) for c in codes]
    assert codes[0] not in "".join(hashes)

    rest = totp.use_recovery(hashes, codes[3].upper().replace("-", " "))  # wielkość liter i separator bez znaczenia
    assert rest is not None and len(rest) == 9
    assert totp.use_recovery(rest, codes[3]) is None
    assert totp.use_recovery(hashes, "zzzz-zzzz") is None


def test_recovery_vs_totp_detection():
    assert totp.looks_like_recovery("ab3k-9xyz")
    assert totp.looks_like_recovery("ab3k9xyz")
    assert not totp.looks_like_recovery("123456")
    assert not totp.looks_like_recovery("123 456")
