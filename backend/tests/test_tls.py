"""HTTPS panelu (od 0.62.0): odczyt certyfikatu z katalogu proxy, adresy dopisane w panelu, API."""

from __future__ import annotations

import ipaddress
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID
from fastapi.testclient import TestClient

from netpulse import tls
from netpulse.api import app
from netpulse.api import tls as tls_api
from netpulse.api.security import require_user
from netpulse.config import settings as real_settings
from netpulse.db.models import User

NOT_AFTER = datetime(2027, 12, 8, 1, 2, 3, tzinfo=UTC)


def _name(cn: str) -> x509.Name:
    return x509.Name([x509.NameAttribute(NameOID.ORGANIZATION_NAME, "NetPulse"), x509.NameAttribute(NameOID.COMMON_NAME, cn)])


def make_tls_dir(root: Path, names: list[str], *, custom: bool = False) -> Path:
    """Katalog jak po deploy/proxy/tls.sh: ca.pem, server.pem, names.active, request/."""
    ca_key = ec.generate_private_key(ec.SECP256R1())
    now = datetime.now(UTC)
    ca = (
        x509.CertificateBuilder()
        .subject_name(_name("NetPulse local CA test"))
        .issuer_name(_name("NetPulse local CA test"))
        .public_key(ca_key.public_key())
        .serial_number(1)
        .not_valid_before(now - timedelta(days=1))
        .not_valid_after(now + timedelta(days=3650))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .sign(ca_key, hashes.SHA256())
    )
    key = ec.generate_private_key(ec.SECP256R1())
    san = []
    for n in names:
        try:
            san.append(x509.IPAddress(ipaddress.ip_address(n)))
        except ValueError:
            san.append(x509.DNSName(n))
    cert = (
        x509.CertificateBuilder()
        .subject_name(_name(names[0]))
        .issuer_name(ca.subject)
        .public_key(key.public_key())
        .serial_number(2)
        .not_valid_before(now - timedelta(days=1))
        .not_valid_after(NOT_AFTER)
        .add_extension(x509.SubjectAlternativeName(san), critical=False)
        .sign(ca_key, hashes.SHA256())
    )
    d = root / "tls"
    (d / "request").mkdir(parents=True)
    (d / "ca.pem").write_bytes(ca.public_bytes(serialization.Encoding.PEM))
    (d / "server.pem").write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    (d / "names.active").write_text("custom\n" if custom else "\n".join(sorted(names)) + "\n")
    return d


@pytest.fixture
def tls_dir(tmp_path, monkeypatch):
    d = make_tls_dir(tmp_path, ["localhost", "127.0.0.1", "192.168.1.34", "netpulse"])
    monkeypatch.setattr(tls, "settings", replace(real_settings, tls_dir=str(d)))
    monkeypatch.setattr(tls_api, "settings", replace(real_settings, tls_dir=str(d), https_port="8443"))
    return d


def client(role: str = "admin") -> TestClient:
    app.dependency_overrides[require_user] = lambda: User(id=1, username="jan", password_hash="x", is_admin=role == "admin", role=role)
    return TestClient(app)


@pytest.fixture(autouse=True)
def _clear():
    yield
    app.dependency_overrides.clear()


def test_normalize_and_host():
    assert tls.normalize_name(" NetPulse.LAN. ") == "netpulse.lan"
    assert tls.normalize_name("[FE80::1]") == "fe80::1"
    assert tls.normalize_name("192.168.1.34") == "192.168.1.34"
    assert tls.normalize_name("zła nazwa") is None
    assert tls.normalize_name("a_b") is None
    assert tls.host_of("192.168.1.34:8443") == "192.168.1.34"
    assert tls.host_of("[fe80::1]:8443") == "fe80::1"
    assert tls.host_of("netpulse") == "netpulse"


def test_covers_exact_ip_and_wildcard():
    assert tls.covers(["192.168.1.34", "netpulse"], "NETPULSE")
    assert tls.covers(["*.lan"], "netpulse.lan")
    assert not tls.covers(["*.lan"], "a.b.lan")
    assert not tls.covers(["netpulse"], "192.168.1.35")


def test_state_reads_certificate(tls_dir):
    st = tls.state()
    assert st.available and st.mode == "local"
    assert set(st.names) == {"localhost", "127.0.0.1", "192.168.1.34", "netpulse"}
    assert st.not_after == NOT_AFTER
    assert st.issuer == "NetPulse local CA test"
    assert st.ca_fingerprint and len(st.ca_fingerprint.split(":")) == 32


def test_state_without_proxy(tmp_path, monkeypatch):
    monkeypatch.setattr(tls, "settings", replace(real_settings, tls_dir=str(tmp_path / "brak")))
    assert tls.state().available is False
    monkeypatch.setattr(tls, "settings", replace(real_settings, tls_dir=""))
    assert tls.state().available is False
    assert tls.ca_pem() is None


def test_save_requested_validates_and_dedupes(tls_dir):
    assert tls.save_requested(["NAS.lan", "nas.lan", "localhost", "10.0.0.5"]) == ["nas.lan", "10.0.0.5"]
    assert (tls_dir / "request" / "names").read_text() == "nas.lan\n10.0.0.5\n"
    assert tls.requested_names() == ["nas.lan", "10.0.0.5"]
    with pytest.raises(ValueError):
        tls.save_requested(["a b"])
    with pytest.raises(ValueError):
        tls.save_requested([f"h{i}.lan" for i in range(tls.MAX_NAMES + 1)])


def test_api_status_and_ca_download(tls_dir):
    c = client("viewer")
    res = c.get("/api/system/tls", headers={"host": "192.168.1.34:8000"})
    assert res.status_code == 200
    body = res.json()
    assert body["available"] and body["https_port"] == 8443 and body["host"] == "192.168.1.34"
    assert body["host_covered"] is True and body["https"] is False
    assert c.get("/api/system/tls", headers={"host": "nas.lan:8000"}).json()["host_covered"] is False

    ca = c.get("/api/system/tls/ca.pem")
    assert ca.status_code == 200 and ca.content.startswith(b"-----BEGIN CERTIFICATE-----")
    assert "netpulse-ca.pem" in ca.headers["content-disposition"]
    assert b"PRIVATE" not in ca.content


def test_api_names_admin_only(tls_dir):
    assert client("operator").put("/api/system/tls/names", json={"names": ["nas.lan"]}).status_code == 403
    c = client("admin")
    res = c.put("/api/system/tls/names", json={"names": ["NAS.lan"]})
    assert res.status_code == 200 and res.json()["requested"] == ["nas.lan"]
    assert c.put("/api/system/tls/names", json={"names": ["zła nazwa"]}).status_code == 422


def test_api_custom_certificate(tmp_path, monkeypatch):
    d = make_tls_dir(tmp_path, ["netpulse.example.com"], custom=True)
    monkeypatch.setattr(tls, "settings", replace(real_settings, tls_dir=str(d)))
    monkeypatch.setattr(tls_api, "settings", replace(real_settings, tls_dir=str(d), https_port="443"))
    body = client("viewer").get("/api/system/tls", headers={"host": "netpulse.example.com"}).json()
    assert body["mode"] == "custom" and body["ca_fingerprint"] is None and body["host_covered"] is True


def test_forwarded_proto_marks_https(tls_dir):
    # Za proxy uvicorn ustawia schemat z X-Forwarded-Proto; TestClient z https:// udaje to samo
    c = client("viewer")
    c.base_url = "https://testserver"
    assert c.get("/api/system/tls").json()["https"] is True
