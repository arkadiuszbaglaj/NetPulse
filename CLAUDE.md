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

## Sposób pracy

- Kod pisze Claude i wypycha na GitHub (`main`). Użytkownik instaluje/aktualizuje na serwerze
  (`install.sh`, potem `netpulse update`) i zgłasza wyniki.
- Każdy push przechodzi CI (`.github/workflows/ci.yml`): ruff, pytest (drivery na fixtures,
  pysnmp kontra snmpsim v2c/v3, kolektor + TimescaleDB, API) oraz test end-to-end `install.sh`
  → `device add` → dane w API → `netpulse update`. Wynik CI sprawdzać przed zgłoszeniem
  użytkownikowi, że wersja jest gotowa.
- **Numer wersji** (`backend/netpulse/__init__.py` i `frontend/package.json` + `package-lock.json`) podnosimy przy każdym wypchnięciu zmian, które użytkownik ma zainstalować: drobne zmiany i poprawki → patch (0.8.0 → 0.8.1), nowa funkcja albo etap → minor (0.8.x → 0.9.0). Bez tego panel pokazuje „dostępne zmiany” przy tym samym numerze wersji.
- Fixtures `backend/tests/fixtures/*.snmprec` to zanonimizowane zrzuty z prawdziwych urządzeń
  (`backend/tools/walk2snmprec.py` – podmienia MAC-i i SSID).

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
- Panel: motyw ciemny i jasny, pulpit z kartami, menu po lewej, pasek górny z kontem i interwałem
  odświeżania; aktualizacja jednym kliknięciem przez osobny kontener `updater`; wykresy i układ
  pulpitu personalizowane na koncie. Szczegóły i etapy 5a–5e: `docs/06-projekt-panelu.md`.
- Kierunek: aplikacja do samodzielnej instalacji przez innych, potem chmura i aplikacja mobilna
  z powiadomieniami i widgetami – panel jest wyłącznie klientem API, sekcje dochodzą przez rejestr modułów.

## Architektura

Każdy producent = driver ze wspólnym interfejsem; driver generyczny (IF-MIB) działa dla
każdego urządzenia ze SNMP, drivery producentów dokładają resztę. Wybór drivera automatyczny
po `sysObjectID` / `sysDescr`.

Kolektor co 30 s: odpytuje urządzenia równolegle, liczy przepływ z różnic liczników
(`ifHCInOctets`/`ifHCOutOctets`; obsługa przepełnienia Counter32 i resetu urządzenia),
zapisuje do TimescaleDB.

Schemat bazy tworzy `init_db` (`create_all`) – nowe **tabele** dochodzą same przy `netpulse update`,
ale nowe **kolumny** w istniejących tabelach nie (init_db zgłosi wtedy niezgodny schemat).
Przed pierwszą zmianą kolumn wprowadzić migracje (Alembic), żeby aktualizacja nie wymagała `netpulse reset`.

## Wyniki analizy SNMP (szczegóły: `docs/02-wyniki-snmp.md`)

- Wszystkie urządzenia: IF-MIB z licznikami 64-bit, UCD-SNMP-MIB (RAM, load).
- UCG Ultra (sysDescr `Ubiquiti UniFi UCG-Ultra ...`): `eth4` = WAN, `eth0`–`eth3` = LAN 1–4 (potwierdzone przez użytkownika). Ukryć interfejsy techniczne: lo, dummy0, ip_vti0, ip6_vti0, ip6tnl0, miireg, bond0, ifb0/1; switch0, switch0.1, br0 jako wirtualne.
- USW Lite 8 PoE (sysDescr `Linux UBNT ...`): porty `ifName` 0/1–0/8, nazwy z UniFi w `ifAlias` (np. „AP U6+”, „UCG Ultra”). BRIDGE-MIB z tablicą MAC. Brak PoE-MIB i LLDP-MIB.
- U6+ (sysObjectID `.1.3.6.1.4.1.41112`): uplink `eth0`; `ra*` = 2.4 GHz, `rai*` = 5 GHz. UBNT-UniFi-MIB VAP table `.1.3.6.1.4.1.41112.1.6.1.2.1`: .2 BSSID, .4 kanał, .6 ESSID, .7 nazwa interfejsu, .8 liczba klientów, .9 radio (ng/na), .10 rx bytes, .16 tx bytes (Counter32). Ukryć wewnętrzne SSID `element-*`, `vwire-*`.
- Czego SNMP nie da: PoE na portach, LLDP/topologia, lista klientów WiFi z nazwami i sygnałem → UniFi Network API (klucz API), etap 6.
- Surowe zrzuty `snmpwalk` **nie trafiają do repo** (MAC-i, SSID, trasy sieci domowej) – są w `.gitignore`; do repo idą tylko zanonimizowane `.snmprec`.

## Plan prac

1. ✅ Inwentaryzacja i test SNMP
2. ✅ Szkielet projektu – struktura, Docker Compose, baza, `install.sh`, `netpulse update`
3. ✅ Kolektor SNMP – driver generyczny IF-MIB + UniFi, zapis metryk (+ wstępne API tylko do odczytu)
4. ✅ Backend API – urządzenia (CRUD + test SNMP), porty, metryki, logowanie (kreator pierwszego konta, sesje w ciasteczku, `netpulse user passwd`)
5. Panel (MVP), etapy: 5a ✅ szkielet (pasek górny, menu, motyw, logowanie; kod w `frontend/`), 5b ✅ dashboard + interwały odświeżania,
   5c ✅ ustawienia (konto, urządzenia, odświeżanie), 5d ✅ aktualizacja jednym kliknięciem (updater + obrazy GHCR),
   5e ✅ personalizacja wykresów i układu, 5f ✅ tryb „Na żywo” (WebSocket, ruch WAN co 1–2 s; opis w `docs/06-projekt-panelu.md`)
6. ✅ Driver UniFi przez API – PoE, klienci WiFi (kontrolery z kluczem API, starsze API `stat/*`; opis: `docs/08-unifi-api.md`)
7. ✅ Topologia LLDP – mapa sieci
8. Alerty (8a ✅ silnik, 8b ✅ panel; brakuje reguł dla dysku i błędów portów oraz powiadomień poza panelem) – port down, przeciążenie, urządzenie offline; reguły z progami (ruch, błędy, CPU/RAM, dysk), lista i historia w panelu, dzwonek w pasku górnym (opis w `docs/06-projekt-panelu.md`, backlog)
9. SNMP v3 ✅ (testowane klientem pysnmp kontra snmpsim w CI), MikroTik i Omada: drivery SNMP gotowe, ale na zrzutach syntetycznych – czekają na prawdziwe zrzuty (opis: `docs/12-mikrotik-omada-snmp.md`); API kontrolera Omada i RouterOS dalej do zrobienia
10. Serwery Linux – etap A: SNMP (`snmpd`, driver `linux`, dyski, karta serwera), etap B: własny agent (push, tokeny, systemd, Docker, SMART; wymaga ogólnej tabeli metryk i Alembic). Opis w `docs/06-projekt-panelu.md` (backlog)

## Do sprawdzenia później

- **Licencje** – propozycja w `docs/09-licencje-propozycja.md` (tylko dokument, bez kodu). Użytkownik wróci do niej
  później i rozstrzygnie pytania otwarte (model biznesowy A/B/C, licencja kodu, dostawca). Do tego czasu nic nie wdrażać.
- **MikroTik na prawdziwym sprzęcie** – użytkownik podłączy routerboard do sieci. Wtedy: zrobić `snmpwalk`,
  zanonimizować (`backend/tools/walk2snmprec.py`), podmienić syntetyczną fixture i sprawdzić driver w panelu.
