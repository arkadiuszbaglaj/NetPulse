"""Certyfikat HTTPS panelu (od 0.62.0) – odczyt stanu i adresy dopisane w panelu.

Certyfikat wystawia i odnawia kontener `proxy` (deploy/proxy/tls.sh) w katalogu `settings.tls_dir`
(na serwerze: <katalog instalacji>/deploy/tls). API tylko czyta certyfikat i CA oraz zapisuje
`request/names` – adresy, które administrator dopisał w panelu; proxy wystawia nowy certyfikat w ciągu ~30 s.
"""

from __future__ import annotations

import hashlib
import ipaddress
import re
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import serialization

from .config import settings

MAX_NAMES = 30
_DNS = re.compile(r"^[a-z0-9]([a-z0-9-]{0,62}\.)*[a-z0-9-]{1,63}$")
BUILTIN = ("localhost", "127.0.0.1")


def normalize_name(raw: str) -> str | None:
    """Adres do certyfikatu: IPv4/IPv6 albo nazwa DNS (małe litery); None = niepoprawny."""
    name = raw.strip().lower().rstrip(".")
    if name.startswith("[") and name.endswith("]"):
        name = name[1:-1]
    try:
        return str(ipaddress.ip_address(name))
    except ValueError:
        pass
    return name if len(name) <= 253 and _DNS.match(name) else None


def host_of(header: str) -> str:
    """Nazwa z nagłówka Host bez portu (też [IPv6]:port)."""
    host = header.strip().lower()
    if host.startswith("["):
        return host[1 : host.find("]")] if "]" in host else host
    if host.count(":") == 1:
        host = host.split(":", 1)[0]
    return host


def covers(names: list[str], host: str) -> bool:
    """Czy certyfikat z adresami `names` pasuje do `host` (także *.domena dla jednego poziomu)."""
    host = normalize_name(host) or host
    for name in names:
        if name == host:
            return True
        if name.startswith("*.") and "." in host and host.split(".", 1)[1] == name[2:]:
            return True
    return False


@dataclass
class TlsState:
    available: bool
    mode: str = "none"  # local | custom | none
    names: list[str] = field(default_factory=list)
    not_after: datetime | None = None
    issuer: str | None = None
    ca_fingerprint: str | None = None
    requested: list[str] = field(default_factory=list)


def _dir() -> Path | None:
    return Path(settings.tls_dir) if settings.tls_dir else None


def _cert_names(cert: x509.Certificate) -> list[str]:
    try:
        san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    except x509.ExtensionNotFound:
        return []
    names = [str(n).lower() for n in san.get_values_for_type(x509.DNSName)]
    names += [str(ip) for ip in san.get_values_for_type(x509.IPAddress)]
    return names


def fingerprint(pem: bytes) -> str:
    der = x509.load_pem_x509_certificate(pem).public_bytes(serialization.Encoding.DER)
    digest = hashlib.sha256(der).hexdigest().upper()
    return ":".join(digest[i : i + 2] for i in range(0, len(digest), 2))


def requested_names() -> list[str]:
    d = _dir()
    path = d / "request" / "names" if d else None
    if path is None or not path.is_file():
        return []
    out = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if (name := normalize_name(line)) and name not in out:
            out.append(name)
    return out


def state() -> TlsState:
    d = _dir()
    if d is None or not (d / "server.pem").is_file():
        return TlsState(available=False)
    try:
        cert = x509.load_pem_x509_certificate((d / "server.pem").read_bytes())
    except (OSError, ValueError):
        return TlsState(available=False)
    custom = (d / "names.active").is_file() and (d / "names.active").read_text(encoding="utf-8").strip() == "custom"
    ca_fp = None
    if not custom and (d / "ca.pem").is_file():
        try:
            ca_fp = fingerprint((d / "ca.pem").read_bytes())
        except ValueError:
            ca_fp = None
    issuer = cert.issuer.get_attributes_for_oid(x509.NameOID.COMMON_NAME)
    return TlsState(
        available=True,
        mode="custom" if custom else "local",
        names=_cert_names(cert),
        not_after=cert.not_valid_after_utc,
        issuer=str(issuer[0].value) if issuer else cert.issuer.rfc4514_string(),
        ca_fingerprint=ca_fp,
        requested=requested_names(),
    )


def ca_pem() -> bytes | None:
    d = _dir()
    path = d / "ca.pem" if d else None
    return path.read_bytes() if path and path.is_file() else None


def save_requested(names: list[str]) -> list[str]:
    """Zapisuje adresy dopisane w panelu (bez wbudowanych localhost/127.0.0.1). Zwraca zapisaną listę."""
    d = _dir()
    if d is None or not (d / "request").is_dir():
        raise FileNotFoundError("Brak katalogu certyfikatów (kontener proxy nie działa?)")
    clean: list[str] = []
    for raw in names:
        name = normalize_name(raw)
        if name is None:
            raise ValueError(f"Niepoprawny adres: {raw}")
        if name not in clean and name not in BUILTIN:
            clean.append(name)
    if len(clean) > MAX_NAMES:
        raise ValueError(f"Najwyżej {MAX_NAMES} adresów")
    tmp = d / "request" / "names.tmp"
    tmp.write_text("".join(f"{n}\n" for n in clean), encoding="utf-8")
    tmp.replace(d / "request" / "names")
    return clean
