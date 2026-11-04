# Źródła producentów: MIB-y, OID-y i API (Ubiquiti, MikroTik, TP-Link Omada)

Stan na **4.11.2026**. Każde źródło poniżej sprawdzone na stronie producenta (pliki MIB pobrane i przejrzane,
specyfikacje OpenAPI odczytane). Cel: wiedzieć, skąd brać dane dla **wszystkich modeli i wersji oprogramowania**
trzech producentów i gdzie są dziury, których SNMP nie zapełni.

## Podsumowanie

| | Ubiquiti UniFi | MikroTik | TP-Link Omada |
|---|---|---|---|
| Oficjalny MIB | tak, ale stary i tylko AP (`UI-MIB`, rewizja 2016) | tak, **osobny plik dla każdej wersji RouterOS** | tak, **osobno dla modeli**: EAP (2017, prawie pusty), switche L2 (2024, pełny) |
| Bramy (routery) | brak prywatnego MIB – standardowe MIB-y Linuksa | MIKROTIK-MIB | brak prywatnego MIB – tylko IF-MIB (oficjalne FAQ) |
| PoE przez SNMP | nie | tak (`mtxrPOETable`) | switche tak (`tplinkPowerOverEthernetMIB`) |
| SFP / DDM | nie | tak (`mtxrOpticalTable`) | switche tak (`ddmStatus`, wartości jako tekst) |
| Klienci WiFi przez SNMP | tylko liczba na SSID | tak (stary pakiet `wireless` i nowy `wifi` od 7.20) | tylko liczba + lista MAC (EAP) |
| SNMPv3 | SHA + AES-128 | MD5/SHA1, w 7.x też SHA256/384/512; DES/AES | MD5/SHA, DES/AES (pełne v3 od kontrolera 6.2.10) |
| Pułapki (traps) | brak („będą w przyszłości”) | link up/down, temperatura | według MIB-ów switchy |
| Oficjalne API | Network API (lokalne, klucz) – **11.0.97** z OpenAPI | REST (RouterOS 7.1+) i API (8728/8729) | Open API kontrolera (OAuth2 client credentials), pełna specyfikacja OpenAPI |
| Czego bez API nie będzie | moc PoE, sygnał klientów, LLDP, switche Flex/Ultra | – (SNMP wystarcza) | moc PoE z EAP/bram, klienci z sygnałem, stan WAN bram |

**Wniosek:** MikroTik da się w pełni obsłużyć przez SNMP. UniFi i Omada wymagają API kontrolera – SNMP daje
tylko ruch na portach i podstawy. Dla UniFi oficjalne API dalej nie ma mocy PoE ani sygnału klientów, więc
starsze `stat/*` zostaje (jak w `docs/08-unifi-api.md`).

---

## 1. Ubiquiti UniFi

### SNMP – oficjalny artykuł
- Artykuł: [SNMP Monitoring in UniFi Network](https://help.ui.com/hc/en-us/articles/33502980942615-SNMP-Monitoring-in-UniFi-Network)
- Włączenie: **Settings → CyberSecure → Traffic Logging → SNMP** (v1/v2c community albo v3: SHA + AES-128).
  Lokalizacja i kontakt per urządzenie: Devices → urządzenie → Settings → SNMP.
- **USW Flex i USW Ultra nie obsługują SNMP** – te switche da się monitorować tylko przez API kontrolera.
- **Pułapek SNMP nie ma** (producent: „będą w przyszłej wersji”).
- MIB: plik `UI-MIB` (załącznik: `https://help.ui.com/hc/article_attachments/33630607557527`, nazwa
  `UI-Combined-MIB`, moduł `UBNT-Combined-MIB`, rewizja **2016-06-25**). Producent sam pisze, że MIB nie jest
  pełny i może nie mieć OID-ów nowszych modeli.

Zawartość `UI-MIB` (gałąź `1.3.6.1.4.1.41112.1.6` – `ubntUniFi`), wszystko dotyczy **access pointów**:

| Tabela / obiekt | Kolumny |
|---|---|
| `unifiIfTable` (`unifiApIf.1`) | nazwa, IP, MAC, duplex, prędkość, bajty/pakiety/błędy/dropy RX i TX (**Counter32**), stan |
| `unifiRadioTable` (`unifiApWireless.1`) | radio (ng/na), pakiety RX/TX, **zajętość kanału** (`CuTotal`, `CuSelfRx`, `CuSelfTx`, `OtherBss`) |
| `unifiVapTable` (`unifiApWireless.2`, czyli `…41112.1.6.1.2.1`) | BSSID, CCQ, kanał, ESSID, nazwa interfejsu, **liczba klientów**, radio, bajty/pakiety/błędy RX/TX, retry, moc TX, stan |
| `unifiApSystem` | IP, izolacja, model, uplink, uptime, wersja |

Zgodne z tym, co driver `unifi` już czyta (VAP: `.2` BSSID, `.4` kanał, `.6` ESSID, `.8` klienci, `.9` radio,
`.10`/`.16` bajty). Nieużywane, a warte dodania: **zajętość kanału** z `unifiRadioTable` i moc TX z VAP.

Switche i bramy UniFi nie mają prywatnego MIB – dają IF-MIB (liczniki 64-bit), BRIDGE-MIB, UCD-SNMP/HOST-RESOURCES
(sprawdzone na naszym sprzęcie, `docs/02-wyniki-snmp.md`).

### Oficjalne API
- Przegląd: [Getting Started with the Official UniFi API](https://help.ui.com/hc/en-us/articles/30076656117655-Getting-Started-with-the-Official-UniFi-API)
- Portal: [developer.ui.com](https://developer.ui.com) – **UniFi Network API 11.0.97**, z plikiem
  `https://developer.ui.com/network/v11.0.97/openapi.json` (i kolekcją Postmana). Dokumentacja dopasowana do
  wersji jest też w samej aplikacji: UniFi Network → Integrations.
- Adres lokalny: `https://<konsola>/proxy/network/integration/v1/...`, nagłówek `X-API-Key`. Ten sam interfejs
  przez chmurę: `https://api.ui.com/v1/connector/consoles/{consoleId}/proxy/network/integration/...`.
- **Site Manager API** (`api.ui.com/v1`) – zbiorczo dla wszystkich lokalizacji (stan urządzeń, ISP); przyda się
  przy wersji chmurowej NetPulse.

Co daje Network API 11.0.97 (sprawdzone w specyfikacji):

| Endpoint | Pola |
|---|---|
| `GET /v1/sites/{siteId}/devices/{deviceId}` | model, firmware, stan (ONLINE/OFFLINE/UPDATING/…), porty: złącze (RJ45/SFP/SFP+/SFP28/QSFP28), prędkość, stan, **PoE: włączone, standard, stan** |
| `GET …/devices/{deviceId}/statistics/latest` | **CPU %, RAM %, load 1/5/15**, uptime, ruch uplinku (bps), radia: pasmo, % retry |
| `GET /v1/sites/{siteId}/clients` | MAC, urządzenie nadrzędne, rodzaj dostępu |
| `GET /v1/sites/{siteId}/wans` | tylko id i nazwa łącza WAN |
| `…/switching/lags`, `mc-lag-domains`, `switch-stacks` | LAG-i i stosy |

Dalej **brak**: mocy PoE w watach, liczników ruchu i błędów na portach, sygnału i SSID klientów, tablicy LLDP,
stanu WAN (aktywne/zapasowe). To jest tylko w starszym `stat/device` i `stat/sta` – zostajemy przy nim,
a oficjalne API traktujemy jako źródło CPU/RAM i stanu urządzeń, także dla switchy bez SNMP (Flex, Ultra).

### Inne linie Ubiquiti
- **airMAX / airOS** (UISP Wireless): oficjalny MIB `https://www.ui.com/downloads/firmwares/airos-ubnt-mib/ubnt-mib.zip`
  (z artykułu [airMAX – Guide to Enable & Test SNMP](https://help.uisp.com/hc/en-us/articles/22590879360919-airMAX-Guide-to-Enable-Test-SNMP)),
  gałąź `…41112.1.4` (sygnał, CCQ, pojemność airMAX). Poza zakresem homelabu – na później.

---

## 2. MikroTik

### MIB – osobny dla każdej wersji
- Strona: [mikrotik.com/download/tools](https://mikrotik.com/download/tools) (pozycja „MikroTik.mib”).
- Wzorzec adresu: `https://download.mikrotik.com/routeros/<wersja>/mikrotik.mib` – sprawdzone dla
  **6.49.18** (rewizja 2020-10-08), **7.20** (2025-05-19), **7.25.1** i **7.26beta1** (2026-09-01).

Dostępność tabel, z których korzystamy albo możemy skorzystać:

| Tabela | OID (`1.3.6.1.4.1.14988.1.1…`) | 6.49 | 7.20 | 7.25.1 | Uwagi |
|---|---|---|---|---|---|
| `mtxrGaugeTable` (czujniki) | `.3.100` | tak | tak | tak | używamy od 0.50.0 |
| `mtxrPOETable` | `.15.1` | tak | tak | tak | używamy od 0.50.0 |
| `mtxrOpticalTable` (SFP) | `.19.1` | tak | tak | tak | używamy od 0.50.0 |
| `mtxrWlRtabTable` (klienci, stary pakiet `wireless`) | `.1.2` | tak | tak | tak | sygnał, prędkości, ruch |
| `mtxrWlCMRtabTable` (klienci CAPsMAN v1) | `.1.5` | tak | tak | tak | |
| `mtxrWifiRegistrationTable` (klienci, **nowy pakiet `wifi`**) | `.21.4` | **nie** | tak | tak | SSID, sygnał, pasmo, prędkości, bajty **Counter64**, VLAN |
| `mtxrRemoteCapTable` (CAP-y nowego CAPsMAN) | `.21.3` | nie | tak | tak | model, wersja, stan |
| `mtxrNeighborTable` (sąsiedzi MNDP/LLDP/CDP) | `.11.1` | tak | tak | tak | mapa sieci bez UniFi |
| `mtxrLTEModemTable` | `.16.1` | tak | tak | tak | RSRP/RSRQ/SINR – zapasowy WAN LTE |
| `mtxrInterfaceTable` | `.24.1` | nie | nie | tak | **liczba zerwań łącza**, czas ostatniego up/down |
| `mtxrNetwatchTable` | `.26.1` | nie | nie | tak | RTT, jitter, straty z Netwatch routera |
| `mtxrVrrpTable`, `mtxrIpPoolTable` | `.25.1`, `.23.1` | nie | nie | tak | |

Wniosek: driver musi **sprawdzać, czy tabela odpowiada**, a nie zakładać wersję (tak już robimy dla
`mtxrHealth` → `mtxrGaugeTable`). Klienci WiFi MikroTika = dwie tabele zależnie od pakietu (`wireless` albo `wifi`).

### Dokumentacja SNMP
- Nowa dokumentacja (stara help.mikrotik.com jest zamrożona):
  [manual.mikrotik.com – SNMP](https://manual.mikrotik.com/docs/diagnostics-monitoring-and-troubleshooting/snmp/)
  (przerobiona w październiku 2026, testowana na 7.26beta1).
- Standardowe MIB-y: IF-MIB, HOST-RESOURCES-MIB, IP-MIB, IP-FORWARD-MIB, IPV6-MIB, BRIDGE-MIB, UPS-MIB, ENTITY-MIB.
- SNMPv3 w 7.x: uwierzytelnianie MD5, SHA1, **SHA256, SHA384, SHA512**; szyfrowanie DES, AES. Hasła min. 8 znaków.
  NetPulse obsługuje te same algorytmy (formularz i `--v3-auth-proto` mają SHA224–SHA512).
- **Wolne OID-y:** gdy usługa odpowiada wolno, agent loguje „timeout while waiting for program” i przez chwilę
  pomija ten OID. Producent zaleca nie odpytywać wolnych OID-ów stale (albo blokować je `denied-oids`).
  Dla nas: tabele klientów i LTE odpytywać rzadziej niż interfejsy.
- `print oid` na dowolnym menu RouterOS pokazuje OID-y na danym urządzeniu – najprostszy sposób na sprawdzenie
  czujników konkretnego modelu (`/system/health/print oid`).

### API RouterOS
- [REST API](https://manual.mikrotik.com/docs/developer-guides/rest-api/): od **RouterOS 7.1beta4**, HTTPS (usługa
  `www-ssl`), Basic Auth, `/rest/<ścieżka menu>`; HTTP dopiero od 7.9 i niezalecane. Limit 60 s na zapytanie,
  bez poleceń ciągłych (`monitor` tylko z `once`).
- [API](https://manual.mikrotik.com/docs/developer-guides/api/) (porty 8728 / 8729 TLS) – działa też na RouterOS 6.
- Na monitoring SNMP wystarcza; API przyda się do tego, czego SNMP nie ma (np. nazwy klientów DHCP).

### SwOS (switche CSS, część CRS)
- SwOS / SwOS Lite to **inny system** niż RouterOS. Według forum MikroTika: tylko SNMP v1/v2c, IF-MIB,
  SNMPv2-MIB, BRIDGE-MIB i **podzbiór MIKROTIK-MIB** (czujniki, PoE, SFP); bez CPU, bez pułapek. SwOS Lite 2.17
  dodał OID-y numeru seryjnego i wersji. To informacje z forum, nie z dokumentacji – do sprawdzenia na sprzęcie.
- Dla NetPulse: rozpoznanie SwOS po `sysDescr` i driver `mikrotik` bez HOST-RESOURCES.

---

## 3. TP-Link Omada

### MIB-y – centrum pobierania Omada
- Strona: [support.omadanetworks.com/download/mibs-files](https://support.omadanetworks.com/en/download/mibs-files/)
  (wyszukiwanie po modelu). Konfiguracja SNMP z kontrolera:
  [How to Configure SNMP on Omada Controller](https://support.omadanetworks.com/en/document/119619/) –
  Site → Network Config → SNMP, kontroler **6.0+**, pełne SNMPv3 (AuthPriv, DES/AES) od **6.2.10**; starsze
  firmware urządzeń dostają domyślną konfigurację v3 (kontroler pokazuje listę).

| Rodzina | Plik | Data | Co ma |
|---|---|---|---|
| Access pointy EAP (wszystkie modele na liście, od EAP110 do EAP783) | `https://static.tp-link.com/EAP_Private_Mibs_1.0.zip` | 2017-04-15 | `…11863.10.1`: **liczba klientów**, tablica MAC klientów, restart. Nic o radiach i sygnale |
| Switche L2/L2+ (SG2xxx, SG3xxx, SX3xxx, np. SG3428X-M2) | `https://static.tp-link.com/upload/software/2024/202402/20240229/L2-tplinkMibs.zip` („TP-Link_L2 Switch_MIB”, 199 KB) | 2024-02-29 | 104 moduły, gałąź `tplinkMgmt` = `1.3.6.1.4.1.11863.6` |
| Bramy ER / DR / FR | **brak na liście** (wyszukiwanie ER605 bez wyników) | – | tylko standardowe MIB-y |

Najważniejsze OID-y switchy (z `L2-tplinkMibs.zip`, baza `1.3.6.1.4.1.11863.6`):

| Moduł | OID | Dane | Jednostki |
|---|---|---|---|
| `tplinkSysInfoMIB` | `.1.1.5` / `.1.1.6` / `.1.1.8` | wersja sprzętu, firmware, numer seryjny | tekst |
| `tplinkSysMonitorMIB` – CPU | `.4.1.1.1.1.{2,3,4}` | CPU 5 s / 1 min / 5 min (wiersz na jednostkę stosu) | % |
| `tplinkSysMonitorMIB` – RAM | `.4.1.2.1.1.2` | zajętość pamięci | % |
| `tplinkPowerOverEthernetMIB` – budżet | `.56.1.1.1.{1,3,4}` | limit, zużycie, zapas mocy systemu | 0,1 W (zakres 1..3200) |
| `tplinkPowerOverEthernetMIB` – porty | `.56.1.1.2.1.1.{7,8,9,10,11}` | moc, prąd, napięcie, klasa PD, stan | 0,1 W; 1 mA; 0,1 V; stan: 0 wył., 1 włączanie, 2 zasila, 3 przeciążenie, 4 zwarcie, 5 niestandardowe PD, 6/7 napięcie za wysokie/niskie, 8 błąd sprzętu, 9 przegrzanie |
| `ddmStatus` (SFP) | `.96.1.7.1.1.{2..9}` | temperatura, napięcie, prąd lasera, TX, RX, gotowość, utrata sygnału, błąd TX | **tekst** (DisplayString) – trzeba parsować liczbę |
| `tplinkLldpMIB` | `.35.1.2.2.1` | sąsiedzi LLDP (port, chassis id, nazwa) | mapa sieci bez kontrolera |
| `tplinkPowerSupplyUnitMIB` | `.88.1.1` | zasilacz wewnętrzny/zewnętrzny | |

### Bramy Omada przez SNMP – oficjalne FAQ
[How to Monitor Omada Gateway Link Status and Traffic Statistics Using SNMP](https://support.omadanetworks.com/en/document/13047/):
bramy dają tylko IF-MIB. **WAN to podinterfejsy VLAN `eth0.<VLAN>`** (przykład: `eth0.10` = WAN1, `eth0.20` = WAN2,
VLAN-y widać w Network → VLAN), LAN = `br-lan`, reszta to interfejsy wewnętrzne.

### Open API kontrolera Omada
- Przewodnik: [How to Create Site in Omada Controller via Open API](https://support.omadanetworks.com/en/document/109315/) –
  Global → Settings → **Platform Integration → Open API → Add New App**, tryb **Client Credentials**; potrzebne
  Client ID, Client Secret, Omada ID i adres interfejsu. Nagłówek `Authorization: AccessToken=<token>`.
  Dokumentacja dopasowana do wersji: przycisk „Online API Document” w kontrolerze.
- Specyfikacja OpenAPI w chmurze TP-Link: `https://use1-omada-northbound.tplinkcloud.com/v3/api-docs/00%20All`
  (1868 ścieżek). Przydatne dla NetPulse (`/openapi/v1/{omadacId}/sites/{siteId}/…`):

| Ścieżka | Dane |
|---|---|
| `devices` | lista urządzeń (EAP, switche, bramy) |
| `clients`, `clients/{clientMac}` | nazwa, IP, SSID, **RSSI, SNR, sygnał**, AP / **switch i port**, prędkości, ruch, uptime |
| `switches/ports/poe-info`, `poe-ports`, `dashboard/poe-usage` | **moc PoE na porcie**, stan łącza, prędkość, ruch |
| `switches/{switchMac}/lldp-neighbors`, `stack/{stackId}/lldp-neighbors` | sąsiedzi LLDP |
| `gateways/{gatewayMac}/wan-status`, `global/gateways/wan-status` | **stan każdego WAN**: internet, IP, prędkość, ruch, opóźnienie, straty, ISP, LTE (RSRP/RSRQ/SNR) |
| `aps/{apMac}/radios`, `aps/{apMac}/lan-traffic-info` | radia i ruch AP |
| `stat/switches/{deviceMac}`, `dashboard/top-device-cpu-usage` | statystyki, CPU/RAM |

Uwagi z forum TP-Link (nie z dokumentacji): błędy `-44106` (zły client id/secret) i `-7131` („Controller ID not
exist”) przy niezgodności wersji dokumentacji i kontrolera; na OC300 port 443. Klienta API pisać pod konkretną
wersję kontrolera i testować na prawdziwym.

---

## 4. Co z tego wynika dla NetPulse

Znalezione rozbieżności w obecnym kodzie (nic jeszcze nie zmienione):

1. **Driver `omada` źle rozpoznaje część bram.** Wzorzec `\bER\d{3}\b` łapie ER605 i ER707, ale **nie ER7206,
   ER8411, ER7212PC** (4 cyfry) ani bram DR/FR – te dostaną typ „switch”, a ich `eth0.10` stanie się „Port 10”.
2. **Brak roli WAN na bramach Omada.** Według FAQ producenta WAN = `eth0.<VLAN>`, LAN = `br-lan`; driver tego
   nie rozpoznaje (to ryzyko R3 z `docs/26-plan-testow-sprzetu.md`).
3. Driver `omada` nie czyta CPU/RAM, PoE ani SFP ze switchy, choć oficjalny MIB je ma (tabela wyżej).
4. MikroTik: brak klientów WiFi (`mtxrWlRtabTable` / `mtxrWifiRegistrationTable`), sąsiadów (`mtxrNeighborTable`)
   i licznika zerwań łącza (`mtxrInterfaceTable`, 7.25+).
5. UniFi: zajętość kanału z `unifiRadioTable` (oficjalny MIB) nieużywana; switche Flex/Ultra bez SNMP – potrzebują
   oficjalnego API (CPU/RAM, stan portów).
6. Omada bez API kontrolera nie da klientów z sygnałem ani mocy PoE z bram/EAP – to odpowiednik etapu 6 dla
   UniFi („API kontrolera Omada” z planu prac).

Proponowana kolejność (do decyzji):
- **A.** Poprawki drivera `omada` z oficjalnych źródeł: rozpoznanie bram, WAN `eth0.<VLAN>`, CPU/RAM/PoE/SFP
  switchy (fixture syntetyczny zgodny z `L2-tplinkMibs.zip`, potem prawdziwy zrzut).
- **B.** MikroTik: klienci WiFi (obie tabele), sąsiedzi, zerwania łącza.
- **C.** Moduł „Omada” – Open API kontrolera (klienci, PoE, WAN, LLDP) – dopiero z prawdziwym kontrolerem.
- **D.** UniFi: oficjalne API dla urządzeń bez SNMP + zajętość kanału z MIB.

Pliki MIB nie trafiają do repozytorium (licencje producentów) – driver opiera się na OID-ach opisanych tutaj,
a testy na fixture'ach `.snmprec`.
