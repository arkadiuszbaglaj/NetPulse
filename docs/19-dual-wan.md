# Dual WAN – dwa łącza internetowe i failover (0.19.0)

Router może mieć dwa (lub więcej) łącza do internetu, np. światłowód jako łącze główne i LTE jako zapasowe.
W trybie **failover** ruch idzie łączem głównym, a gdy ono padnie, router przełącza go na zapasowe.
NetPulse pokazuje, które łącze działa, którym idzie teraz ruch, kiedy nastąpiło przełączenie i jaka jest
dostępność (SLA) każdego łącza.

## Co jest w panelu

| Miejsce | Co pokazuje |
|---------|-------------|
| Widget **Aktywny WAN** | Porty WAN routera i ich stan. Zielona kropka: łącze jest w użyciu (idzie nim ruch). Czerwona: łącze nieaktywne – pusta to łącze zapasowe gotowe do przejęcia ruchu, pełna to awaria. Nad listą: „Teraz: …”, czyli łącze, którym idzie ruch. |
| Widget **Aktywne łącze WAN** | Wykres z osobną linią dla każdego WAN-u. Linia łącza jest rysowana tylko wtedy, gdy szedł nim ruch, więc po awarii WAN 1 linia WAN 2 zaczyna się w chwili przełączenia. Pod wykresem są pasy stanu każdego łącza (zielony – w użyciu, jasnoczerwony – zapas, czerwony – awaria) i lista ostatnich przełączeń. |
| Widget **SLA łączy WAN** | Dostępność każdego łącza w % za 24 godz., 7 albo 30 dni (przełącznik w karcie), liczba przerw, łączny czas przerw, najdłuższa przerwa, ile czasu łącze niosło ruch i ostatnia przerwa (albo trwająca). |
| **Ustawienia → Łącza WAN** | Które porty routera są WAN 1, WAN 2… Kolejność to priorytet: WAN 1 to łącze główne. |

Widgety dodaje się jak inne: Dashboard → Edytuj pulpit → Dodaj widget. W ustawieniach widgetu można wybrać router
(gdy jest ich kilka), a dla wykresu pobieranie albo wysyłanie, zakres czasu i wysokość.

## Konfiguracja: które porty są WAN 1 i WAN 2

1. Port, który driver rozpoznaje jako WAN (na UCG Ultra `eth4`), NetPulse dodaje sam jako **WAN 1** przy pierwszym
   odczycie routera.
2. Drugie łącze dodajesz w **Ustawienia → Łącza WAN → Dodaj łącze**: router, port (np. `LAN 4 (eth3)`, jeśli ten port
   ustawiłeś w UniFi jako WAN 2) i nazwa (np. „LTE”). Strzałkami ustawiasz kolejność, potem **Zapisz**.
3. Port ustawiony jako łącze WAN dostaje w NetPulse rolę WAN. Jego ruch wlicza się do kafelków i wykresu ruchu WAN,
   trybu „Na żywo” i alertów progowych WAN, a na liście portów ma nazwę łącza.
4. Od pierwszego zapisu w panelu NetPulse nie dodaje już sam portów WAN, bo możesz celowo usunąć któryś port z listy.
   Usunięcie łącza kasuje jego historię i SLA.

Zmiany zapisuje tylko administrator. Stan łączy odświeża się w następnym cyklu kolektora (co 30 s).

## Skąd wiadomo, że łącze działa i że jest aktywne

Co cykl kolektora (30 s) NetPulse ustala dla każdego łącza dwie rzeczy.

**Sprawne (up).** Port ma link (`ifOperStatus` = up z SNMP), a kontroler UniFi, jeśli coś o łączu wie, nie zgłasza
awarii. UniFi sprawdza też, czy przez łącze jest internet, więc wykrywa awarię u operatora nawet wtedy, gdy kabel
jest podłączony i link jest „up”.

**W użyciu (active)** – którym łączem idzie ruch. Źródła informacji, od najważniejszego:

1. **Kontroler UniFi** (moduł UniFi włączony i kontroler dodany w Ustawienia → Kontrolery UniFi). Z `stat/device`
   bramy NetPulse czyta pola `wan1`/`wan2` (czy łącze działa), `uplink` (interfejs, którym idzie teraz ruch) i porty
   oznaczone `is_uplink`. Ta informacja jest ważna przez 90 s, potem NetPulse przechodzi na metodę 2.
2. **Ruch z SNMP** (zawsze dostępny). Jeśli sprawne jest tylko jedno łącze, to ono jest aktywne, nawet nocą bez ruchu.
   Jeśli sprawne są oba, aktywne jest to, którym idzie ruch: łącze zapasowe w trybie failover przenosi tylko małe
   pakiety kontrolne. Za aktywne uznawane jest łącze z ruchem od 50 kb/s i co najmniej 20% ruchu najbardziej
   obciążonego łącza. Dlatego przy równoważeniu obciążenia (load balance) aktywne są oba łącza naraz. Gdy w sieci
   jest cisza, zostaje łącze, które było aktywne wcześniej.

Stany łącza: **w użyciu** (zielony), **nieaktywne – zapas** (czerwony pusty), **nie działa** (czerwony pełny),
**brak danych** (szary – router nie odpowiada na SNMP albo kolektor nie działa).

## Jak liczone jest SLA

- Każda próbka (co 30 s) obowiązuje do następnej, najdłużej 90 s. Dłuższa luka to **brak danych**: nie liczy się
  ani do dostępności, ani jako przerwa. Panel podaje, ile czasu było bez danych.
- **Dostępność** = czas, w którym łącze było sprawne ÷ czas, dla którego są dane × 100%. Wynik nie jest zaokrąglany
  w górę, więc 99,999% pokazuje się jako 99,99%, a nie 100%. Kolor: zielony od 99,9%, pomarańczowy od 99%, poniżej czerwony.
- **Przerwa** to ciągły odcinek, w którym łącze nie działało. Liczba przerw, łączny czas, najdłuższa i ostatnia
  przerwa dotyczą wybranego okresu (24 godz., 7 albo 30 dni).
- Łącze zapasowe, które czeka bez ruchu, jest sprawne. Jego SLA to gotowość, a nie czas pracy. Czas pracy pokazuje
  pole „Niosło ruch”.

Historia jest trzymana tak długo jak inne metryki (`NETPULSE_RETENTION_DAYS`, domyślnie 30 dni).

## API

| Metoda i adres | Co zwraca |
|----------------|-----------|
| `GET /api/wan/status` | łącza z bieżącym stanem (`active`, `standby`, `down`, `unknown`), ruchem, czasem zmiany stanu i źródłem decyzji (`controller`/`traffic`); `active_ids` – łącza w użyciu |
| `GET /api/wan/history?minutes=60` | punkty wykresu (`in_<id>`, `out_<id>` – ruch łącza tylko wtedy, gdy było aktywne), odcinki stanów (`segments`) i przełączenia (`switches`) |
| `GET /api/wan/sla?days=7` | dla każdego łącza: `availability`, `outages`, `down_s`, `longest_outage_s`, `active_s`, `unknown_s`, `recent_outages` |
| `GET /api/wan/links` | konfiguracja łączy |
| `PUT /api/wan/links` | zapis pełnej listy `{"links": [{"interface_id": 8, "name": "Światłowód"}, …]}` w kolejności (administrator) |

## Dla programisty

- Baza: `wan_links` (konfiguracja i bieżący stan, pola `ctrl_*` od kontrolera) i hypertable `wan_link_metrics`
  (`up`, `active`, `in_bps`, `out_bps` co cykl), migracja `0006_wan_links.py`.
- `backend/netpulse/wan.py` – czyste funkcje: `decide` (stan łączy w cyklu), `segments`, `compute_sla`, `switches`.
- `backend/netpulse/wan_links.py` – zapis w transakcji kolektora SNMP (`record`, `mark_unknown`) i dane od kontrolera
  (`apply_controller`, wywoływane przez `unifi_collector.py`).
- `backend/netpulse/unifi.py` – `parse_wans`: porty WAN bramy z `stat/device`. Starsze odpowiedzi nie mają `ifname`
  przy portach, wtedy port N to `ethN-1` (tak jest na UCG Ultra i UDM). `tools/probe2fixtures.py` zachowuje teraz
  pola `wan1`/`wan2`/`uplink` (bez adresów IP).
- Testy: `tests/test_wan.py` (logika, parser UniFi), `tests/test_wan_db.py` (kolektor na zrzucie UCG Ultra, awaria
  WAN 1 → WAN 2, API), panel: `frontend/src/pages/Wan.test.tsx`.

## Stan

Zrobione i przetestowane na zrzutach (`ucg-ultra.snmprec`, `unifi_devices.json`) i atrapach. Do sprawdzenia na
prawdziwym drugim łączu:

1. Ustawić WAN 2 w panelu.
2. Odłączyć WAN 1 i sprawdzić przełączenie w widgetach.
3. Zrobić zrzut kontrolera (`unifi_probe.py`, `probe2fixtures.py`). Sprawdzić, czy `wan1`/`wan2`/`uplink` mają
   `ifname`, i podmienić fixture.
