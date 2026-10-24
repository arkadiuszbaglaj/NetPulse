# NetPulse

Self-hosted aplikacja webowa do monitorowania sieci w homelabie: ruch na portach routera,
switchy i access pointów, zebrany w jednym panelu (wykresy, statusy portów, topologia, klienci WiFi).

## Cele

- Jeden panel: router → switch → access point, z ruchem na każdym porcie.
- Wykresy przepustowości, błędów i dropów; status portów (up/down, prędkość, PoE).
- Obsługa wielu producentów przez system sterowników (driverów).
- Łatwa instalacja na Ubuntu Server (Docker Compose).

## Obsługiwane urządzenia

| Producent        | Status       | Źródła danych                          |
|------------------|--------------|----------------------------------------|
| Ubiquiti UniFi   | etap 1       | SNMP (IF-MIB) + UniFi Network API      |
| MikroTik         | planowane    | SNMP (IF-MIB, MIKROTIK-MIB) + RouterOS API |
| TP-Link Omada    | planowane    | SNMP (IF-MIB) + Omada Controller API   |
| Inne             | później      | generyczny driver SNMP (IF-MIB)        |

Sprzęt testowy (etap 1): UniFi Cloud Gateway Ultra, USW Lite 8 PoE, U6+.

SNMP: v2c od początku, v3 (authPriv) przewidziane w modelu danych i kolektorze.

## Instalacja (docelowo)

Jedna komenda na czystym Ubuntu Server:

```bash
curl -fsSL https://raw.githubusercontent.com/arkadiuszbaglaj/NetPulse/main/install.sh | sudo bash
```

Potem dodaj urządzenia (`netpulse device add ...`), a aktualizuj jednym poleceniem:

```bash
netpulse update
```

Szczegóły: [`docs/04-instalacja-i-aktualizacja.md`](docs/04-instalacja-i-aktualizacja.md).

## Stack technologiczny

| Warstwa            | Technologia                                              |
|--------------------|----------------------------------------------------------|
| Kolektor           | Python 3.13, asyncio, `pysnmp` 7 (v1/v2c/v3)             |
| Backend API        | FastAPI, Pydantic v2, SQLAlchemy 2 (async)               |
| Baza danych        | PostgreSQL 17 + TimescaleDB (metryki jako hypertables)   |
| Zadania / kolejka  | Redis (cache bieżących wartości, pub/sub do live update) |
| Frontend           | React 19 + TypeScript, Vite, Tailwind CSS, TanStack Query, Apache ECharts |
| Live update        | WebSocket (FastAPI) → wykresy na żywo                    |
| Wdrożenie          | Docker Compose na Ubuntu Server 24.04 LTS                |

Dlaczego Python: najlepsze biblioteki SNMP (w tym v3), szybki rozwój, a asyncio
pozwala odpytywać dziesiątki urządzeń równolegle bez problemu.

## Architektura

```
 [Router] [Switch] [AP]  ──SNMP/API──►  Kolektor (async, co 30 s)
                                            │
                                            ▼
                              PostgreSQL + TimescaleDB  ◄──  Backend API (FastAPI)
                                            ▲                     │  REST + WebSocket
                                          Redis ◄─────────────────┤
                                                                  ▼
                                                     Frontend (React) – panel
```

### Drivery urządzeń

Każdy producent to osobny driver z jednym wspólnym interfejsem:

- `discover()` – rozpoznanie urządzenia (sysObjectID, sysDescr), lista portów
- `poll_interfaces()` – liczniki portów (ifHCInOctets/ifHCOutOctets, błędy, dropy, status)
- `poll_extra()` – dane specyficzne (PoE, klienci WiFi, CPU/RAM, temperatura)
- `neighbors()` – sąsiedzi LLDP (do mapy topologii)

Driver generyczny (IF-MIB) działa dla każdego urządzenia ze SNMP, a drivery producentów
dokładają dane dodatkowe.

## Plan prac

1. ✅ **Inwentaryzacja i test SNMP** – włączenie SNMP, `snmpwalk` z serwera Ubuntu (→ `docs/01-snmp-test.md`, `docs/02-wyniki-snmp.md`)
2. ✅ **Szkielet projektu** – struktura, Docker Compose, baza, `install.sh`, `netpulse update`
3. ✅ **Kolektor SNMP** – driver generyczny IF-MIB + UniFi, zapis metryk do TimescaleDB
4. **Backend API** – urządzenia, porty, metryki, uwierzytelnianie
5. **Panel (MVP)** – lista urządzeń, widok portów, wykresy ruchu
6. **Driver UniFi** – PoE, klienci WiFi z UniFi Network API
7. **Topologia LLDP** – mapa sieci router → switch → AP
8. **Alerty** – port down, przeciążenie łącza, urządzenie offline
9. **SNMP v3, MikroTik, Omada**

## Struktura katalogów

```
NetPulse/
├── backend/        # FastAPI + kolektor (wspólny kod modeli i driverów)
├── frontend/       # React + Vite
├── deploy/         # docker-compose.yml, .env.example
├── scripts/        # polecenie `netpulse` na serwerze (update, status, logs...)
├── install.sh      # instalator jednym linkiem
└── docs/           # dokumentacja i instrukcje krok po kroku
```
