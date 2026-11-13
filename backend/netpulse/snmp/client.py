"""Klient SNMP oparty o pysnmp 7 (asyncio), obsługuje v1, v2c i v3."""

from __future__ import annotations

import logging
from typing import Any

from pyasn1.type import univ
from pysnmp.hlapi.v3arch import asyncio as hl
from pysnmp.proto import rfc1902, rfc1905

from .types import SnmpCredentials, SnmpError, SnmpValue

log = logging.getLogger(__name__)

_MAX_REPETITIONS = 25


def _const(*names: str) -> Any:
    """Zwraca stałą pysnmp – nazwy różnią się między wersjami (USM_AUTH_* vs usm*)."""
    for name in names:
        value = getattr(hl, name, None)
        if value is not None:
            return value
    raise SnmpError(f"Nieobsługiwany protokół SNMPv3: {names[0]}")


_AUTH_PROTOCOLS = {
    "MD5": ("USM_AUTH_HMAC96_MD5", "usmHMACMD5AuthProtocol"),
    "SHA": ("USM_AUTH_HMAC96_SHA", "usmHMACSHAAuthProtocol"),
    "SHA224": ("USM_AUTH_HMAC128_SHA224", "usmHMAC128SHA224AuthProtocol"),
    "SHA256": ("USM_AUTH_HMAC192_SHA256", "usmHMAC192SHA256AuthProtocol"),
    "SHA384": ("USM_AUTH_HMAC256_SHA384", "usmHMAC256SHA384AuthProtocol"),
    "SHA512": ("USM_AUTH_HMAC384_SHA512", "usmHMAC384SHA512AuthProtocol"),
}
_PRIV_PROTOCOLS = {
    "DES": ("USM_PRIV_CBC56_DES", "usmDESPrivProtocol"),
    "AES": ("USM_PRIV_CFB128_AES", "usmAesCfb128Protocol"),
    "AES192": ("USM_PRIV_CFB192_AES", "usmAesCfb192Protocol"),
    "AES256": ("USM_PRIV_CFB256_AES", "usmAesCfb256Protocol"),
}

# Błędy pysnmp (`errorIndication`) po polsku, z podpowiedzią, co sprawdzić (od 0.77.0; wcześniej w „Test SNMP”
# i w last_error urządzenia był angielski tekst pysnmp). Klucz = nazwa klasy błędu z pysnmp.proto.errind.
ERROR_HINTS = {
    "RequestTimedOut": "brak odpowiedzi w wyznaczonym czasie – sprawdź adres, port UDP, wersję SNMP i community (albo dane SNMPv3)",
    "UnknownUserName": "urządzenie nie zna tego użytkownika SNMPv3",
    "UnknownSecurityName": "urządzenie nie zna tego użytkownika SNMPv3",
    "WrongDigest": "zły klucz albo protokół uwierzytelniania SNMPv3 (auth)",
    "DecryptionError": "zły klucz albo protokół szyfrowania SNMPv3 (priv)",
    "AuthenticationError": "zły klucz albo protokół szyfrowania SNMPv3 (priv)",
    "UnsupportedSecurityLevel": "urządzenie nie obsługuje tego poziomu bezpieczeństwa SNMPv3 – sprawdź, czy ma włączone uwierzytelnianie i szyfrowanie",
    "NotInTimeWindow": "zegar SNMPv3 urządzenia poza oknem czasu – spróbuj ponownie",
    "UnknownEngineID": "urządzenie nie odpowiedziało poprawnie na wykrywanie SNMPv3 (engine ID)",
}


def explain(err_ind: Any) -> str:
    """Czytelny opis błędu pysnmp; nieznany błąd – tekst pysnmp bez zmian."""
    return ERROR_HINTS.get(type(err_ind).__name__, str(err_ind))


def _auth_data(creds: SnmpCredentials) -> Any:
    if creds.version in ("1", "2c"):
        return hl.CommunityData(creds.community, mpModel=0 if creds.version == "1" else 1)
    if not creds.username:
        raise SnmpError("SNMPv3 wymaga nazwy użytkownika")
    kwargs: dict[str, Any] = {}
    if creds.auth_protocol:
        kwargs["authKey"] = creds.auth_key
        kwargs["authProtocol"] = _const(*_AUTH_PROTOCOLS[creds.auth_protocol])
    if creds.priv_protocol:
        kwargs["privKey"] = creds.priv_key
        kwargs["privProtocol"] = _const(*_PRIV_PROTOCOLS[creds.priv_protocol])
    return hl.UsmUserData(creds.username, **kwargs)


def _convert(value: Any) -> SnmpValue | None:
    """Zamienia typ pysnmp na int / bytes / str; None dla noSuch* / endOfMibView."""
    if isinstance(value, (rfc1905.NoSuchObject, rfc1905.NoSuchInstance, rfc1905.EndOfMibView)):
        return None
    if isinstance(value, rfc1902.IpAddress):
        return ".".join(str(b) for b in value.asOctets())
    if isinstance(value, univ.OctetString):
        return bytes(value.asOctets())
    if isinstance(value, univ.ObjectIdentifier):
        return str(value)
    try:
        return int(value)
    except (TypeError, ValueError):
        return value.prettyPrint()


# Typy SMI → znacznik .snmprec (snmpsim); kolejność ma znaczenie: Counter32/Gauge32/TimeTicks dziedziczą po Integer
_TYPED_TAGS: tuple[tuple[str, str], ...] = (
    ("Counter64", "70"),
    ("Counter32", "65"),
    ("Gauge32", "66"),
    ("Unsigned32", "66"),
    ("TimeTicks", "67"),
    ("IpAddress", "64"),
    ("Opaque", "68"),
)


def _typed(value: Any) -> tuple[str, str] | None:
    """Wartość pysnmp → (znacznik .snmprec, wartość); None dla noSuch* / endOfMibView."""
    if isinstance(value, (rfc1905.NoSuchObject, rfc1905.NoSuchInstance, rfc1905.EndOfMibView)):
        return None
    cls_names = {c.__name__ for c in type(value).__mro__}
    for name, tag in _TYPED_TAGS:
        if name in cls_names:
            if tag == "64":
                return tag, ".".join(str(b) for b in value.asOctets())
            if tag == "68":
                return "4x", bytes(value.asOctets()).hex()
            return tag, str(int(value))
    if isinstance(value, univ.OctetString):
        return "4x", bytes(value.asOctets()).hex()
    if isinstance(value, univ.ObjectIdentifier):
        return "6", str(value)
    try:
        return "2", str(int(value))
    except (TypeError, ValueError):
        return None


class PySnmpClient:
    """Asynchroniczny klient SNMP dla jednego urządzenia."""

    def __init__(
        self,
        host: str,
        credentials: SnmpCredentials,
        port: int = 161,
        timeout: float = 2.0,
        retries: int = 1,
    ) -> None:
        self.host = host
        self.port = port
        self.credentials = credentials
        self.timeout = timeout
        self.retries = retries
        self._engine = hl.SnmpEngine()
        self._auth = _auth_data(credentials)
        self._context = hl.ContextData(contextName=credentials.context_name)
        self._target: Any = None

    async def _get_target(self) -> Any:
        if self._target is None:
            try:
                self._target = await hl.UdpTransportTarget.create(
                    (self.host, self.port), timeout=self.timeout, retries=self.retries
                )
            except Exception as exc:  # błąd DNS / adresu
                raise SnmpError(f"{self.host}: {exc}") from exc
        return self._target

    async def get(self, oids: list[str]) -> dict[str, SnmpValue]:
        if not oids:
            return {}
        target = await self._get_target()
        err_ind, err_status, err_index, var_binds = await hl.get_cmd(
            self._engine,
            self._auth,
            target,
            self._context,
            *[hl.ObjectType(hl.ObjectIdentity(oid)) for oid in oids],
            lookupMib=False,
        )
        if err_ind:
            raise SnmpError(explain(err_ind))
        if err_status:
            # v1 zwraca noSuchName dla całego zapytania – traktujemy jako brak danych
            if str(err_status.prettyPrint()) == "noSuchName" and len(oids) > 1:
                result: dict[str, SnmpValue] = {}
                for oid in oids:
                    result.update(await self.get([oid]))
                return result
            if str(err_status.prettyPrint()) == "noSuchName":
                return {}
            raise SnmpError(f"{self.host}: {err_status.prettyPrint()}")
        result = {}
        for name, value in var_binds:
            converted = _convert(value)
            if converted is not None:
                result[str(name)] = converted
        return result

    async def _iterate(self, prefix: str):
        """Kolejne (OID, surowa wartość pysnmp) poddrzewa `prefix` (bez wartości spoza niego)."""
        target = await self._get_target()
        if self.credentials.version == "1":
            iterator = hl.walk_cmd(
                self._engine,
                self._auth,
                target,
                self._context,
                hl.ObjectType(hl.ObjectIdentity(prefix)),
                lexicographicMode=False,
                lookupMib=False,
            )
        else:
            iterator = hl.bulk_walk_cmd(
                self._engine,
                self._auth,
                target,
                self._context,
                0,
                _MAX_REPETITIONS,
                hl.ObjectType(hl.ObjectIdentity(prefix)),
                lexicographicMode=False,
                lookupMib=False,
            )
        async for err_ind, err_status, _err_index, var_binds in iterator:
            if err_ind:
                raise SnmpError(explain(err_ind))
            if err_status:
                if str(err_status.prettyPrint()) == "noSuchName":
                    break
                raise SnmpError(f"{self.host}: {err_status.prettyPrint()}")
            for name, value in var_binds:
                name_s = str(name)
                if name_s.startswith(prefix + "."):
                    yield name_s, value

    async def walk(self, oid: str) -> dict[str, SnmpValue]:
        prefix = oid.strip(".")
        result: dict[str, SnmpValue] = {}
        async for name_s, value in self._iterate(prefix):
            converted = _convert(value)
            if converted is not None:
                result[name_s[len(prefix) + 1 :]] = converted
        return result

    async def walk_typed(self, oid: str, limit: int | None = None) -> list[tuple[str, str, str]]:
        """Poddrzewo jako rekordy .snmprec `(OID, typ, wartość)` – do raportu urządzenia (`netpulse/devreport.py`).
        `limit` przerywa odczyt po tylu wartościach (gałęzie producentów potrafią mieć dziesiątki tysięcy)."""
        prefix = oid.strip(".")
        out: list[tuple[str, str, str]] = []
        async for name_s, value in self._iterate(prefix):
            rec = _typed(value)
            if rec is not None:
                out.append((name_s, *rec))
            if limit is not None and len(out) >= limit:
                break
        return out

    async def close(self) -> None:
        closer = getattr(self._engine, "close_dispatcher", None) or getattr(
            self._engine, "closeDispatcher", None
        )
        if closer:
            try:
                closer()
            except Exception:  # pragma: no cover - sprzątanie
                log.debug("close_dispatcher failed", exc_info=True)
