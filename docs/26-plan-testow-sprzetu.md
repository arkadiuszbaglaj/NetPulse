# Plan testów na różnym sprzęcie – propozycja

Status: **propozycja** (4.11.2026). Do decyzji użytkownika, co i w jakiej kolejności robimy.

## Cel

NetPulse ma działać u ludzi z różnym sprzętem: inni producenci, różne wersje firmware, NAS-y, serwery. Dziś
sprawdzony jest głównie sprzęt UniFi użytkownika, MikroTik CHR, Linux i Proxmox. Plan ma odpowiedzieć na
dwa pytania:

1. Czy aplikacja **działa** (nie wysypuje się, kolektor nie staje) na nieznanym sprzęcie?
2. Czy dane są **poprawne** (ruch, porty, CPU/RAM, dyski) i czytelne (bez technicznych interfejsów, z rolą WAN)?

## Stan dziś

- Fixtures w `backend/tests/fixtures/`: `ucg-ultra`, `usw-lite-8-poe`, `u6-plus`, `linux-server`, `mikrotik-chr`
  (prawdziwe zrzuty) oraz `mikrotik-hex`, `tplink-jetstream` (syntetyczne).
- CI: drivery na fixtures, pysnmp kontra snmpsim (v2c i v3), kolektor z TimescaleDB, test `install.sh`.
- Wybór drivera: najwyższy wynik `match()`; driver ogólny pasuje zawsze (`match = 1`), `linux` łapie każde
  `sysDescr` zaczynające się od `Linux ` (także NAS-y).
- Klient SNMP: timeout 2 s, 1 ponowienie; interfejsy czytane kolumna po kolumnie (17 walków IF-MIB na cykl).
- Obrazy budowane lokalnie na serwerze (`docker compose build`) – architektura ARM nigdy nie była sprawdzana.

## Znane ryzyka do sprawdzenia

| # | Ryzyko | Skutek | Jak sprawdzić |
|---|---|---|---|
| R1 | Liczniki 32-bitowe na łączu ≥ 1 Gb/s (przekręcenie w ~34 s przy cyklu 30 s) | za mały ruch, skoki na wykresie | test jednostkowy `rates` z licznikiem przekręconym dwa razy; zrzut urządzenia bez `ifHC*` |
| R2 | Driver ogólny pokazuje wszystkie interfejsy (VLAN, loopback, tunele, mosty) | bałagan w tabelach i na pulpicie | zrzuty różnych producentów, przegląd listy portów |
| R3 | Brak roli WAN na routerze nieznanego producenta | puste widgety WAN i „Na żywo” | nowa instalacja z routerem innym niż UniFi |
| R4 | Zmiana `ifIndex` po restarcie / dodaniu VLAN-u (`UniqueConstraint(device_id, if_index)`) | pomieszana historia portów, zły port WAN | zrzut „przed” i „po” z przesuniętymi indeksami w teście kolektora |
| R5 | Duże lub wolne urządzenie (dużo interfejsów, słaby CPU) | przekroczenie czasu, urządzenie „offline” | snmpsim z opóźnieniem i fixture z kilkuset interfejsami |
| R6 | Dziwne wartości: `ifSpeed` 0 albo 4294967295, puste `ifName`, liczniki zerowane bez restartu, teksty spoza UTF-8 | błędne prędkości, nazwy `ifN`, ujemne lub ogromne skoki ruchu | fixture „złośliwy” z takimi wartościami |
| R7 | Urządzenie bez UCD-SNMP-MIB (większość switchy zarządzalnych) | brak CPU/RAM | sprawdzić, czy panel pokazuje „brak danych”, a nie 0 % |
| R8 | NAS: brak RAID, SMART, temperatur (MIB-y producentów) | NAS wygląda jak zwykły Linux | zrzuty Synology / QNAP / TrueNAS |
| R9 | SNMP v1, tylko v3, inne community, zły kontekst v3 | brak danych, mylące komunikaty | snmpsim w trybach v1 i v3 z różnymi ustawieniami |
| R10 | Serwer inny niż Ubuntu x86-64 (Debian, ARM / Raspberry Pi) | instalacja się nie uda | maszyna wirtualna Debian, Raspberry Pi lub runner ARM w CI |

## Źródła sprzętu do testów (bez kupowania)

**Maszyny wirtualne w VirtualBoxie** (jak MikroTik CHR):

- routery: OpenWrt x86, pfSense, OPNsense, VyOS – różne `sysDescr`, VLAN-y, tunele, często bez UCD,
- NAS: TrueNAS SCALE i OpenMediaVault (darmowe, SNMP w panelu). Synology DSM ma oficjalnie tylko Virtual DSM
  na Synology – w VirtualBoxie nie testujemy (licencja),
- serwery: Debian 12/13, Rocky Linux – instalacja `install.sh` i SNMP przez `snmpd`.

**Zrzuty od innych osób** – zanonimizowane `.snmprec` (`walk2snmprec.py`) od znajomych, z forów, z publicznych
zgłoszeń. To jedyna droga do Cisco, HP/Aruba, Netgear, Zyxel, Synology, QNAP. Zanim powstanie raport urządzenia
z `docs/24-wykrywanie-propozycja.md` (część B), wystarczy instrukcja w `docs/` z poleceniem `snmpwalk`.

**Fixtures syntetyczne** – pisane ręcznie na podstawie MIB-ów i dokumentacji producenta, tylko do testów przypadków
brzegowych (R1, R4, R5, R6). Zawsze oznaczone jako syntetyczne, jak `mikrotik-hex`.

## Etapy

### Etap 1 – testy odporności w CI (bez nowego sprzętu)

- fixture „złośliwy” (R6): prędkości 0 i 2³²−1, puste `ifName`, długie i nie-UTF-8 opisy, brak części kolumn,
- fixture „duży” (R5): kilkaset interfejsów i VLAN-ów; snmpsim z opóźnieniem odpowiedzi – czas cyklu kolektora
  i zachowanie przy przekroczeniu czasu,
- testy kolektora: liczniki 32-bitowe przekręcone raz i dwa razy (R1), zerowanie liczników bez zmiany uptime,
  przesunięcie `ifIndex` (R4),
- snmpsim w trybie v1 i v3 z błędnymi danymi (R9) – czytelny komunikat w „Test SNMP”,
- urządzenie bez UCD (R7) – API i panel zwracają `null`, nie 0.

Wynik: lista błędów do poprawienia, każdy jako osobna poprawka (patch). Najtańszy etap – zaczynamy od niego.

### Etap 2 – maszyny wirtualne

- OPNsense albo pfSense oraz OpenWrt: dodanie przez panel, lista portów (R2), rola WAN (R3), ruch pod obciążeniem
  (`iperf3` przez router), zrzut do fixtures,
- TrueNAS SCALE i OpenMediaVault: dyski, pule, CPU/RAM (R8), zrzut do fixtures,
- Debian jako serwer NetPulse: `install.sh`, `netpulse update` (R10).

Wynik: nowe fixtures z prawdziwych systemów + decyzje, czy potrzebne nowe drivery (np. `opnsense`, `truenas`).

### Etap 3 – zrzuty od innych osób

- instrukcja „Jak przygotować zrzut urządzenia” w `docs/` (polecenie `snmpwalk`, anonimizacja, gdzie wysłać),
- szablon zgłoszenia na GitHubie („Nowe urządzenie”: model, firmware, `sysObjectID`, załącznik `.snmprec`),
- każdy przyjęty zrzut = fixture + test drivera; dla nieznanego producenta przynajmniej test „driver ogólny nie
  pokazuje śmieci” (R2).

### Etap 4 – poprawki wynikające z testów (przykłady, jeśli się potwierdzą)

- **R2**: ukrywanie interfejsów technicznych także w driverze ogólnym (po `ifType`: loopback, tunnel, l2vlan,
  propVirtual), z możliwością pokazania w panelu,
- **R3**: podpowiedź w kreatorze `/setup` i na stronie routera „Wskaż port WAN”, gdy driver go nie zna,
- **R4** ✅ (0.65.7, po aktualizacji UCG Ultra do UniFi OS 6.0.17): dopasowanie portów po `ifName`, gdy `ifIndex`
  się zmienił (`netpulse/ifindex.py`, test `test_ifindex.py` i `test_collector_db.py`),
- **R5**: `GETBULK` z większym `max-repetitions`, timeout i liczba ponowień ustawiane per urządzenie,
- **R8**: drivery NAS (Synology, QNAP, TrueNAS) albo profile z `docs/25-wlasne-oid-propozycja.md` (warstwa 3),
- **R10**: oficjalnie wspierane systemy w `docs/04-instalacja-i-aktualizacja.md`, `install.sh` z jasnym
  komunikatem na niewspieranym systemie.

### Etap 5 – macierz zgodności

Tabela w `docs/` (później na stronie projektu): producent / model / firmware / źródło (prawdziwy sprzęt, VM,
zrzut, syntetyczny) / co działa (porty, ruch, CPU/RAM, dyski, WiFi, PoE, WAN, LLDP). Uzupełniana z każdym
nowym fixture. Użytkownik widzi przed instalacją, czego się spodziewać.

## Kolejność

1. Etap 1 – od razu, bez sprzętu, w CI.
2. Etap 2 – OPNsense i TrueNAS SCALE na start (najbardziej popularne w homelabach).
3. Etap 4 – poprawki na bieżąco, po każdym potwierdzonym ryzyku.
4. Etapy 3 i 5 – gdy pojawią się pierwsi użytkownicy spoza domu.

## Pytania otwarte

- Czy wspieramy Raspberry Pi / ARM jako serwer NetPulse – jeśli tak, potrzebny runner ARM w CI.
- Czy przyjmować zrzuty publicznie (GitHub) przed decyzją o licencji (`docs/09-licencje-propozycja.md`) –
  zrzut to dane, nie kod, ale warto mieć zgodę na użycie w repo.
