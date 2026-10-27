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

Schemat bazy zmieniają **migracje Alembic** (od 0.10.0; `backend/netpulse/db/migrations/`, opis:
`docs/13-migracje-bazy.md`). `init_db` (kolektor przy starcie, `netpulse db init`) wykonuje `upgrade head` pod blokadą
w jednej transakcji, potem zakłada hypertables. Każda zmiana w `models.py` = nowa migracja (`--rev-id 0002`, …);
brak migracji wyłapie `test_migrations.py::test_fresh_db_matches_models`. Migracja bazowa `0001` = schemat 0.9.0
i przejmuje bazy sprzed migracji bez utraty danych.

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
8. ✅ Alerty (8a silnik, 8b panel, reguły dysku i błędów portów, powiadomienia: webhook/Telegram, od 0.25.0 ntfy i e-mail (SMTP), ciche godziny z podsumowaniem po ciszy, grupowanie po topologii LLDP; opis: `docs/21-powiadomienia.md`) – port down, przeciążenie, urządzenie offline; reguły z progami (ruch, błędy, CPU/RAM, dysk), lista i historia w panelu, dzwonek w pasku górnym (opis w `docs/06-projekt-panelu.md`, backlog)
9. SNMP v3 ✅ (testowane klientem pysnmp kontra snmpsim w CI), MikroTik i Omada: drivery SNMP gotowe, ale na zrzutach syntetycznych – czekają na prawdziwe zrzuty (opis: `docs/12-mikrotik-omada-snmp.md`); API kontrolera Omada i RouterOS dalej do zrobienia
10. Serwery Linux – etap A ✅ SNMP (`snmpd`, driver `linux`, dyski, karta serwera), etap B ✅ (0.11.0) własny agent: push z tokenem (`api/agents.py`), jeden plik Pythona `backend/netpulse/agent/netpulse_agent.py` + `install.sh` serwowane przez API, systemd, Docker, SMART, ogólna tabela `metrics` (migracja 0002), Ustawienia → Agenci. Opis: `docs/14-agent-linux.md`. Alerty z agenta ✅ (0.12.0: kontener, usługa, SMART, temperatura; pole `alert_rules.match`, migracja 0003); wykresy z `metrics` ✅ (0.13.0, źródła `agent_*` w edytorze wykresu); strona szczegółów serwera `/devices/<id>/server` i ostrzeżenie „agent starszy niż NetPulse” ✅ (0.24.0)

## Kopie zapasowe

Od 0.14.0: Ustawienia → Kopia zapasowa (utworzenie, pobranie, wgranie z komputera od 0.16.0, przywrócenie z kopią bezpieczeństwa) i `netpulse backup`;
`netpulse update` robi kopię przed zmianą kodu. Wykonuje je updater (`updater/netpulse_updater/backups.py`), opis: `docs/15-kopia-zapasowa.md`.

## Szyfrowanie sekretów

Od 0.15.0 community SNMP, klucze SNMPv3, klucz API kontrolera i adresy webhooków są w bazie zaszyfrowane
(`backend/netpulse/crypto.py`, typ kolumny `EncryptedText`, prefiks `enc:v1:`). Klucz: plik w wolumenie `netpulse_keys`
(tworzony sam) albo `NETPULSE_SECRET_KEY` w `.env`. Nowa kolumna z sekretem = `EncryptedText` + wpis w `SECRET_COLUMNS`.
Opis: `docs/16-szyfrowanie-sekretow.md`.

## Proxmox VE

Od 0.17.0: Ustawienia → Proxmox (token API, rola PVEAuditor), strona Proxmox (VM/LXC, magazyny), węzły jako urządzenia
`driver = "proxmox"` (karta, alerty, wykresy), alerty: maszyna zatrzymana, kopia vzdump z błędem, brak świeżej kopii.
Kod: `backend/netpulse/proxmox.py`, `proxmox_collector.py`, `api/proxmox.py`; atrapa API do testów: `backend/tests/pve_fake.py`.
Opis: `docs/17-proxmox.md`. Sprawdzone 2026-10-27 na prawdziwym PVE 9.1.1 (jeden węzeł, zatrzymana VM, bez kopii) –
parsery bez zmian; uruchomiona VM/LXC, kopie vzdump i klaster dalej tylko na atrapie.

## Moduły

Od 0.18.0: Ustawienia → Moduły (Proxmox, UniFi, agenci, kopia zapasowa z panelu). Wyłączony moduł znika z panelu, kolektor
go pomija, jego urządzenia i reguły alertów są pomijane; dane zostają. Nowa instalacja startuje z wyłączonymi integracjami.
Backend: `netpulse/modules.py` (`require_module`, `hidden_drivers`), panel: pole `module` w rejestrze `frontend/src/modules.tsx`.
Nowa integracja = nowy moduł. Opis: `docs/18-moduly.md`.

## Dual WAN (failover)

Od 0.19.0: łącza WAN routera (`wan_links`, historia w hypertable `wan_link_metrics`, migracja 0006). Port z rolą `wan`
w driverze zostaje sam WAN 1; kolejne porty ustawia się w Ustawienia → Łącza WAN (port dostaje rolę `wan`, więc wlicza się
do ruchu WAN, „Na żywo” i alertów). „Aktywne” = informacja z kontrolera UniFi (`wan1`/`wan2`, `uplink`, `is_uplink`),
bez kontrolera – link (`ifOperStatus`) i ruch. Logika: `backend/netpulse/wan.py` (czysta), zapis: `wan_links.py`,
API: `api/wan.py` (`/api/wan/status|history|sla|links`), widgety `wan_status`, `wan_chart`, `wan_sla`.
Opis: `docs/19-dual-wan.md`. **Testowane na zrzutach i atrapie – czeka na prawdziwe drugie łącze.**

## Szczegóły, dostępność i pulpity

Od 0.20.0–0.23.0 (opis: `docs/20-szczegoly-i-pulpity.md`):
- Strony szczegółów (trasy ukryte w menu: `hidden: true` w `frontend/src/modules.tsx`): urządzenie `/devices/<id>`,
  port `/devices/<id>/ports/<id>`, klient `/clients/<MAC>`. Dostępność w %: `api/availability.py`.
- Ciągłe agregaty godzinowe TimescaleDB (`netpulse/aggregates.py`, zakłada `init_db`, poza Alembikiem): wykresy 30 dni
  i 1 rok (`RangeMinutes`), powyżej 7 dni zapytania idą do widoków `*_1h`. Przed `drop_all` w testach: `aggregates.drop_all`.
- Historia klientów: `client_metrics` + `known_clients` (migracja 0007), API `api/clients.py`.
- Kreator pierwszej konfiguracji `/setup` (otwiera się po założeniu konta).
- Wiele pulpitów (`dashboards`, jeden `is_default`), Ustawienia → Dashboardy z kreatorem, pulpit publiczny `/p/<token>`
  (migracja 0008): API `api/public.py` z białą listą danych z widgetów pulpitu – **nowy widget = dopisać jego ścieżki
  w `resolve()`**; w panelu `setPublicDashboard` w `lib/api.ts` kieruje zapytania widgetów do API publicznego.

## Wykresy (przebudowa w stylu Grafany)

Plan etapów A–C: `docs/22-wykresy.md` (wzory: folder `graf/`, poza repo). Etap A ✅ (0.26.0): widget `chart` ma `queries`
(do 6 źródeł, 12 serii; `offset_min` = porównanie z godziną/dniem/tygodniem wcześniej – parametr `offset` w API metryk),
osie lewa/prawa, progi, legendę lista/tabela z min/maks/śr./ostatnią, stos. Stary format (`source`, `series`, `y_max`)
zamienia `upgrade_chart` w `layout_schemas.py` (i `upgradeChartConfig` w panelu). Render: `components/charts/PanelChart.tsx`
+ `ChartLegend.tsx` + czyste funkcje `panelData.ts`; edytor: `components/widgets/ChartEditor.tsx`. Pulpit publiczny
przepuszcza `offset` tylko taki, jaki ma zapytanie. Etap B ✅ (0.27.0): widgety `stat` (liczba z mini-wykresem), `bargauge`
(paski), `table`, `state_timeline` (oś stanów); dane: `api/panels.py` (`/api/collections/{kind}`, `/api/states`), panel:
`components/widgets/PanelWidgets.tsx` + `PanelEditors.tsx`, `lib/panels.ts`. Etap C ✅ (0.28.0): swobodna siatka
(`x`, `y`, `h` na widgecie, `w` 1–12; `components/DashboardGrid.tsx` z react-grid-layout, `placeWidgets` układa stare
pulpity), sekcje zwijane (`type: "section"`). Podgląd panelu bez serwera: atrapa `frontend/dev/mock-api.mjs` + `.claude/launch.json`.

## Do sprawdzenia później

- **Licencje** – propozycja w `docs/09-licencje-propozycja.md` (tylko dokument, bez kodu). Użytkownik wróci do niej
  później i rozstrzygnie pytania otwarte (model biznesowy A/B/C, licencja kodu, dostawca). Do tego czasu nic nie wdrażać.
- **MikroTik**: ✅ (0.28.2) sprawdzony na prawdziwym RouterOS 7.18.2 (CHR w VirtualBox, 192.168.1.62) – fixture
  `mikrotik-chr.snmprec`, rozpoznawanie WAN po nazwie portu. Fizyczny routerboard (kilka rdzeni, PPPoE, czujniki
  MIKROTIK-MIB) dalej tylko na syntetycznym `mikrotik-hex.snmprec`.
- **API RouterOS i API kontrolera Omada** – robić dopiero z prawdziwym sprzętem (razem z weryfikacją MikroTika).
- **Proxmox – reszta na prawdziwym sprzęcie** – PVE 9.1.1 (192.168.1.86) działa; gdy użytkownik uruchomi VM/LXC
  i zrobi kopię vzdump: sprawdzić CPU/RAM/sieć gościa, alerty kopii i „brak świeżej kopii” (skrypt odczytu przez kontener API).
- **Dual WAN na prawdziwym sprzęcie** – po podłączeniu drugiego łącza: ustawić WAN 2 w panelu, wyciągnąć kabel WAN 1
  i sprawdzić przełączenie w widgetach. Pobrać `unifi_probe.py` i sprawdzić, czy `stat/device` bramy ma `wan1`/`wan2`/`uplink`
  z `ifname` (parser zakłada port N = ethN-1, gdy go brak); zanonimizowany zrzut (`probe2fixtures.py`) podmienić w fixtures.
- **Wersja 0.9.0 na serwerze** – użytkownik jeszcze nie potwierdził `netpulse update` i działania: karta serwera
  NetPulse, serwery Linux przez SNMP, reguły alertów dla dysku i błędów portów, powiadomienia webhookiem.
