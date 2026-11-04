# Etap 6 – driver UniFi przez API (PoE i klienci WiFi)

SNMP nie podaje PoE na portach ani listy klientów WiFi (nazwa, IP, sygnał). Te dane ma
**UniFi Network API**. Kolejność prac:

1. **6a – rozpoznanie** (ten dokument): sprawdzamy na prawdziwym kontrolerze, co API zwraca,
   i zapisujemy zanonimizowany zrzut jako dane testowe (jak `.snmprec` dla SNMP).
2. **6b – klient API i model danych:** klucz API przy urządzeniu (przechowywany tak jak community),
   nowe tabele na PoE portów i klientów WiFi, test połączenia w „Dodaj urządzenie”.
3. **6c – kolektor i panel:** odczyt co cykl kolektora, PoE na portach switcha, lista klientów WiFi,
   widgety na pulpicie.

## 6a. Klucz API i sonda

1. W UniFi Network: **Settings → Control Plane → Integrations → Create API Key**
   (nazwa dowolna, np. `netpulse`). Skopiuj klucz – widać go tylko raz. Klucz daje dostęp tylko do odczytu
   tego, co udostępnia API integracji; nie wpisuj go do czatu ani do repozytorium.
2. Na serwerze z NetPulse pobierz sondę i uruchom ją, podając klucz zmienną środowiskową:

```bash
curl -fsSLO https://raw.githubusercontent.com/arkadiuszbaglaj/NetPulse/main/backend/tools/unifi_probe.py
UNIFI_API_KEY='wklej-klucz' python3 unifi_probe.py 192.168.1.1
```

3. Sonda wypisuje kody odpowiedzi dla kolejnych adresów API i zapisuje `unifi_probe_192.168.1.1.json`.
   MAC-i, IP, nazwy, SSID, numery seryjne i identyfikatory są w nim zastąpione pseudonimami,
   a struktura i liczby (PoE, sygnał, ruch) zostają. Przejrzyj plik i podaj go do dalszej pracy.

Wersja aplikacji UniFi Network (Settings → System → About) też się przyda: API integracji zmienia się
między wersjami.

## Wyniki rozpoznania (UniFi Network 10.6.109)

Klucz API działa z obydwoma adresami; wszystko odpowiada kodem 200.

| Adres | Co daje | Czego brakuje |
|-------|---------|---------------|
| `/proxy/network/integration/v1/…` (API integracji, oficjalne) | wersja aplikacji, urządzenia, stan portów, **PoE tylko jako włączone/stan**, lista klientów (nazwa, IP, MAC, port nadrzędny) | moc PoE w watach, sygnał WiFi, SSID, port klienta |
| `/proxy/network/api/s/default/stat/device` (starsze, nieoficjalne) | **moc, napięcie i prąd PoE na porcie**, budżet PoE switcha, ruch i błędy na portach, tabela LLDP | stabilny kontrakt producenta |
| `/proxy/network/api/s/default/stat/sta` (starsze, nieoficjalne) | klienci: nazwa/hostname, IP, **sygnał (dBm)**, SSID, radio, prędkości łącza, AP albo **switch i port** (np. telewizor na porcie 7), czas połączenia | – |

Decyzja: dane bierzemy ze starszego API (`stat/device`, `stat/sta`), bo tylko ono ma to, po co jest etap 6.
Integracji używamy do sprawdzenia połączenia i wersji. Starsze API nie jest kontraktem producenta,
więc parsery (`backend/netpulse/unifi.py`) są tolerancyjne (brak pola = brak wartości, nie błąd),
a test na zanonimizowanych odpowiedziach (`backend/tests/fixtures/unifi_*.json`, powstałych
z `backend/tools/probe2fixtures.py`) wykryje zmianę formatu po aktualizacji UniFi.

Urządzenie z kontrolera łączymy z urządzeniem NetPulse (SNMP) po adresie IP, a port PoE z portem
`0/N` switcha. LLDP z tej samej odpowiedzi posłuży w etapie 7 (mapa sieci).

## Stan prac

- **6a ✅** rozpoznanie.
- **6b ✅ (backend)** kontrolery UniFi (tabela `controllers`, klucz API w bazie jak community SNMP, nigdy nie wraca w API),
  kolektor (`unifi_collector.py`, uruchamiany razem z kolektorem SNMP), tabele `poe_port_metrics`, `poe_budget_metrics`,
  `network_clients` (nowe tabele powstają same przy `netpulse update`), API: `/api/controllers` (CRUD i test połączenia),
  `/api/clients?kind=wifi|wired`, `/api/devices/{id}/poe`.
- **6c** panel: Ustawienia → Kontrolery UniFi (dodawanie z testem), strona Klienci, PoE przy portach switcha, widgety.

## Urządzenia bez SNMP z oficjalnego API (0.52.0)

Część sprzętu UniFi nie ma SNMP (np. USW Flex, USW Flex Mini, USW Ultra). Od 0.52.0 kolektor UniFi czyta
oficjalne Network API (`/proxy/network/integration/v1`, ten sam klucz API) i **sam zakłada** urządzenia, których
NetPulse nie zna z SNMP, z `driver = "unifi_api"`:

- lista: `GET /sites` (site, którego `internalReference` to nazwa ze starszego API, zwykle `default`),
  `GET /sites/{site}/devices` (strony `offset`/`limit` ≤ 200, `totalCount`),
- szczegóły: `GET /sites/{site}/devices/{id}` (porty: stan, prędkość, PoE włączone; radia AP) i
  `GET …/statistics/latest` (CPU, RAM, load, uptime),
- liczniki ruchu i błędów portów – oficjalne API ich nie ma, więc ze starszego `stat/device` (`port_table`).

Odczyt zapisuje się tą samą drogą co wynik drivera SNMP (`unifi_devices.build_poll_result` → `Collector.save_result`),
więc karta urządzenia, porty, wykresy, „Dostępność” i alerty działają bez zmian. Nazwy portów switcha to `0/N`
(jak `ifName` w SNMP), bramy i AP `ethN-1`; porty WAN bramy według `wan1`/`wan2` ze `stat/device`.

Rodzaj urządzenia: typ ze starszego API (`udm`/`usw`/`uap`) ma pierwszeństwo – oficjalne API opisuje UCG Ultra tylko
jako `switching` – potem model (UCG/UDM/UDR/UXG…), potem `features`.

Łączenie z istniejącymi urządzeniami (tabela `unifi_api_devices`, migracja 0012, klucz: kontroler + MAC):
- urządzenie znane z SNMP (po IP, adresie LAN z LLDP albo MAC-u interfejsu) – pomijane, bez duplikatu,
- urządzenie `unifi_api` usunięte w panelu – wpis zostaje z `device_id = NULL` i kolektor go **nie zakłada ponownie**,
- dodanie urządzenia SNMP pod tym samym adresem zamienia urządzenie `unifi_api` w SNMP (historia zostaje),
- kontroler niedostępny – jego urządzenia `unifi_api` są „niedostępne” (alert „urządzenie nie odpowiada”),
- kontroler bez oficjalnego API – PoE i klienci działają jak wcześniej, urządzeń bez SNMP po prostu nie ma.

Urządzenia `unifi_api` należą do modułu UniFi (wyłączony moduł = ukryte), nie mają testu SNMP ani danych „Na żywo”
(odczyt co 30 s). Fixture: `backend/tests/fixtures/unifi_official.json` (zanonimizowane odpowiedzi kontrolera 10.6.109).

Przy okazji (z oficjalnego UI-MIB): AP przez SNMP podaje **zajętość kanału** każdego radia (`unifiRadioTable`,
kolumna CuTotal) – metryka `channel_util_percent` w tabeli `metrics`, klucz = pasmo (2.4GHz, 5GHz, 6GHz);
na wykresie: źródło „Czujnik urządzenia”.

## Etap 7 – mapa sieci (LLDP)

`stat/device` zawiera tablicę LLDP każdego urządzenia (`lldp_table`: port lokalny i adres MAC sąsiada).
Kolektor zapisuje ją co cykl jako zdjęcie stanu (`topology_links`). `GET /api/topology` łączy wpisy obu końców
kabla w jedną krawędź z numerami portów po obu stronach; sąsiad, którego kontroler nie zna (np. modem na porcie WAN),
trafia na mapę jako „Nieznane urządzenie”. Panel (**Mapa sieci**) rysuje drzewo: brama w środku, modem nad nią,
niżej switche i AP, a przy każdym urządzeniu liczba klientów WiFi i klienci po kablu z numerem portu
(np. telewizor na porcie 7). Pod mapą jest lista połączeń tekstem.
