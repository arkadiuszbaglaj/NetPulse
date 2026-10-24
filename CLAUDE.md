# NetPulse – kontekst projektu dla Claude Code

## O projekcie

NetPulse to self-hosted aplikacja webowa do monitorowania sieci w homelabie. Zbiera w jednym
panelu ruch i stan portów routera, switchy i access pointów: wykresy przepustowości, błędy,
status portów, klienci WiFi, a później topologia i alerty.

Repozytorium: https://github.com/arkadiuszbaglaj/NetPulse

## Zasady współpracy

- Komunikacja z użytkownikiem **po polsku**. Kod, nazwy w kodzie i komentarze techniczne mogą być po angielsku, dokumentacja w `docs/` po polsku.
- Użytkownik chce być prowadzony **krok po kroku**: po każdym etapie krótko podsumuj, co powstało i jak to sprawdzić, i zaproponuj następny krok.
- Testuj na prawdziwych urządzeniach (sieć 192.168.1.0/24 jest osiągalna z serwera).
- **Instalacja jednym linkiem** jest wymaganiem: NetPulse ma się instalować na czystym Ubuntu Server
  jedną komendą, np.
  `curl -fsSL https://raw.githubusercontent.com/arkadiuszbaglaj/NetPulse/main/install.sh | sudo bash`
  (skrypt instaluje Dockera, jeśli go brak, pobiera projekt, tworzy `.env` z losowymi hasłami i uruchamia `docker compose up -d`).

## Środowisko docelowe

- Ubuntu Server (na start), wdrożenie przez Docker Compose.
- Urządzenia testowe (Ubiquiti UniFi), SNMP v2c, community `public` (do zmiany przed produkcją):

| Urządzenie          | IP          | Rola         |
|---------------------|-------------|--------------|
| Cloud Gateway Ultra | 192.168.1.1 | router       |
| USW Lite 8 PoE      | 192.168.1.2 | switch       |
| U6+                 | 192.168.1.3 | access point |

- Port 7 switcha: telewizor (link 100 Mb/s – to normalne).
- Przyszłe wsparcie: MikroTik, TP-Link Omada, potem inne. SNMP v3 musi być przewidziane od początku (model danych + klient).

## Stack

- Backend / kolektor: Python 3.13, asyncio, `pysnmp` 7 (v1/v2c/v3), FastAPI, SQLAlchemy 2 async, asyncpg
- Baza: PostgreSQL 17 + TimescaleDB (metryki jako hypertables, retention policy)
- Frontend: React 19 + TypeScript, Vite, Tailwind CSS, TanStack Query, Apache ECharts
- Live update: WebSocket; Redis dojdzie, gdy będzie potrzebny
- Kolorystyka panelu: do ustalenia z użytkownikiem przy etapie frontendu

## Architektura

Każdy producent = driver ze wspólnym interfejsem; driver generyczny (IF-MIB) działa dla
każdego urządzenia ze SNMP, drivery producentów dokładają resztę. Wybór drivera automatyczny
po `sysObjectID` / `sysDescr`.

Kolektor co 30 s: odpytuje urządzenia równolegle, liczy przepływ z różnic liczników
(`ifHCInOctets`/`ifHCOutOctets`; obsługa przepełnienia Counter32 i resetu urządzenia),
zapisuje do TimescaleDB.

## Stan kodu (po kroku 2)

- `backend/` – projekt `uv` (`pyproject.toml` + `uv.lock`), FastAPI w `app/main.py`, modele w `app/models.py`,
  migracje Alembic w `migrations/versions/` (hypertables, kompresja 7 dni, retencja 90 dni tworzone w migracji SQL-em).
  Zmiana schematu = nowa migracja Alembic; `alembic check` musi przechodzić (indeksy `*_time_idx` TimescaleDB są ignorowane w `env.py`).
- `deploy/docker-compose.yml` – `db` (`timescale/timescaledb:2.31.0-pg17`, bez portu na hoście) + `backend` (port `NETPULSE_PORT`, domyślnie 8080). Backend robi `alembic upgrade head` przy starcie.
- `install.sh` – idempotentny: instalacja i aktualizacja; `.env` tworzony tylko raz. Zmienne `NETPULSE_DIR`, `NETPULSE_REPO`, `NETPULSE_BRANCH`.
- Sprawdzanie: `cd backend && uv run pytest && uv run ruff check . && uv run ruff format --check .`

## Wyniki analizy SNMP (szczegóły: `docs/02-wyniki-snmp.md`)

- Wszystkie urządzenia: IF-MIB z licznikami 64-bit, UCD-SNMP-MIB (RAM, load).
- UCG Ultra (sysDescr `Ubiquiti UniFi UCG-Ultra ...`): `eth4` = WAN, `eth0`–`eth3` = LAN 1–4 (potwierdzone przez użytkownika). Ukryć interfejsy techniczne: lo, dummy0, ip_vti0, ip6_vti0, ip6tnl0, miireg, bond0, ifb0/1; switch0, switch0.1, br0 jako wirtualne.
- USW Lite 8 PoE (sysDescr `Linux UBNT ...`): porty `ifName` 0/1–0/8, nazwy z UniFi w `ifAlias` (np. „AP U6+”, „UCG Ultra”). BRIDGE-MIB z tablicą MAC. Brak PoE-MIB i LLDP-MIB.
- U6+ (sysObjectID `.1.3.6.1.4.1.41112`): uplink `eth0`; `ra*` = 2.4 GHz, `rai*` = 5 GHz. UBNT-UniFi-MIB VAP table `.1.3.6.1.4.1.41112.1.6.1.2.1`: .2 BSSID, .4 kanał, .6 ESSID, .7 nazwa interfejsu, .8 liczba klientów, .9 radio (ng/na), .10 rx bytes, .16 tx bytes (Counter32). Ukryć wewnętrzne SSID `element-*`, `vwire-*`.
- Czego SNMP nie da: PoE na portach, LLDP/topologia, lista klientów WiFi z nazwami i sygnałem → UniFi Network API (klucz API), etap 6.
- Surowe zrzuty `snmpwalk` mogą służyć jako fixtures do testów, ale **nie trafiają do repo** (MAC-i, SSID, trasy sieci domowej) – są w `.gitignore`.

## Plan prac

1. ✅ Inwentaryzacja i test SNMP
2. ✅ Szkielet projektu – struktura, Docker Compose, baza, `install.sh`
3. Kolektor SNMP – driver generyczny IF-MIB + UniFi, zapis metryk
4. Backend API – urządzenia, porty, metryki, uwierzytelnianie
5. Panel (MVP) – lista urządzeń, widok portów, wykresy ruchu
6. Driver UniFi przez API – PoE, klienci WiFi
7. Topologia LLDP – mapa sieci
8. Alerty – port down, przeciążenie, urządzenie offline
9. SNMP v3, MikroTik, Omada
