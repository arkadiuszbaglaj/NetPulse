#!/usr/bin/env python3
"""Sonda UniFi Network API: sprawdza, co odpowiada, i zapisuje zanonimizowany zrzut odpowiedzi.

Używa tylko biblioteki standardowej, więc działa na gołym serwerze. Klucz API przekazujemy
zmienną środowiskową (nie trafia do historii poleceń ani do zrzutu):

    UNIFI_API_KEY=... python3 unifi_probe.py 192.168.1.1

Zrzut `unifi_probe_<host>.json` ma podmienione adresy MAC i IP, nazwy urządzeń i klientów, SSID,
numery seryjne i identyfikatory (stałe pseudonimy, struktura i liczby zostają), ale i tak przejrzyj go
przed wysłaniem dalej. Plik jest w .gitignore.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import ssl
import sys
import urllib.error
import urllib.request

INTEGRATION = "/proxy/network/integration/v1"
LEGACY = "/proxy/network/api/s/default"

MAC_RE = re.compile(r"\b[0-9a-fA-F]{2}(?:[:-][0-9a-fA-F]{2}){5}\b")
IP_RE = re.compile(r"\b\d{1,3}(?:\.\d{1,3}){3}\b")
UUID_RE = re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b")
# Klucze, których wartości tekstowe zastępujemy pseudonimem w całości
NAME_KEYS = {"name", "hostname", "ssid", "essid", "serial", "serialnumber", "displayname", "note", "alias", "oui", "fingerprint"}


def pseudo(text: str, kind: str) -> str:
    return f"{kind}-{hashlib.sha256(text.encode()).hexdigest()[:6]}"


def fake_mac(match: re.Match) -> str:
    h = hashlib.sha256(match.group().lower().encode()).hexdigest()
    return "02:00:" + ":".join(h[i : i + 2] for i in (0, 2, 4, 6))


def anonymize(value, key: str = ""):
    if isinstance(value, dict):
        return {k: anonymize(v, k) for k, v in value.items()}
    if isinstance(value, list):
        return [anonymize(v, key) for v in value]
    if isinstance(value, str):
        if key.lower() in NAME_KEYS:
            return pseudo(value, key.lower())
        value = MAC_RE.sub(fake_mac, value)
        value = UUID_RE.sub(lambda m: pseudo(m.group(), "id"), value)
        return IP_RE.sub(lambda m: "10.0.0." + str(int(hashlib.sha256(m.group().encode()).hexdigest(), 16) % 250 + 2), value)
    return value


def fetch(host: str, path: str, key: str, ctx: ssl.SSLContext) -> dict:
    req = urllib.request.Request(f"https://{host}{path}", headers={"X-API-KEY": key, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15, context=ctx) as res:
            body = res.read().decode("utf-8", "replace")
            try:
                return {"status": res.status, "json": json.loads(body)}
            except ValueError:
                return {"status": res.status, "text": body[:300]}
    except urllib.error.HTTPError as exc:
        return {"status": exc.code, "text": exc.read().decode("utf-8", "replace")[:300]}
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return {"status": None, "error": str(exc)}


def main() -> int:
    if len(sys.argv) != 2 or not os.environ.get("UNIFI_API_KEY"):
        print(__doc__)
        return 2
    host, key = sys.argv[1], os.environ["UNIFI_API_KEY"]
    # Kontroler ma certyfikat samopodpisany – to sonda w sieci lokalnej, więc weryfikacji nie wymagamy
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

    out: dict[str, dict] = {}

    def probe(path: str) -> dict:
        res = fetch(host, path, key, ctx)
        out[path] = res
        print(f"{res.get('status')!s:>5}  {path}")
        return res

    probe(f"{INTEGRATION}/info")
    sites = probe(f"{INTEGRATION}/sites").get("json", {}).get("data", [])
    for site in sites[:1]:
        sid = site["id"]
        devices = probe(f"{INTEGRATION}/sites/{sid}/devices?limit=200").get("json", {}).get("data", [])
        for dev in devices:
            probe(f"{INTEGRATION}/sites/{sid}/devices/{dev['id']}")
            probe(f"{INTEGRATION}/sites/{sid}/devices/{dev['id']}/statistics/latest")
        probe(f"{INTEGRATION}/sites/{sid}/clients?limit=200")
    # Starsze API (jeśli klucz je obsługuje): bogatsze dane o portach i PoE
    probe(f"{LEGACY}/stat/device")
    probe(f"{LEGACY}/stat/sta")

    name = f"unifi_probe_{host}.json"
    with open(name, "w", encoding="utf-8") as f:
        json.dump(anonymize(out), f, ensure_ascii=False, indent=1)
    print(f"\nZapisano {name} (zanonimizowany). Przejrzyj go przed wysłaniem dalej.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
