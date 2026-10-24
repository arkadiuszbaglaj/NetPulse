# Projekt panelu (krok 5) i kierunek rozwoju

Dokument opisuje, jak ma wyglądać i działać panel webowy oraz jak go budować, żeby dało się
go rozwijać (w stronę chmury, aplikacji mobilnej z powiadomieniami i widgetów) bez przepisywania.
Decyzje zapadły wspólnie z autorem projektu; zmiany zapisujemy tutaj.

## Założenia produktowe

- NetPulse ma być **pełnoprawną aplikacją webową**, którą każdy instaluje u siebie jedną komendą.
- Panel jest **tylko klientem API**. Wszystko, co robi panel, może zrobić też aplikacja mobilna
  albo chmura (to samo API, te same definicje widgetów).
- Sekcje panelu dochodzą z czasem – menu i ustawienia budujemy jako **rejestr modułów**, a nie na sztywno.

## Wygląd (ustalone)

- Motyw **ciemny i jasny** (domyślnie według systemu, ręczny przełącznik zapamiętany na koncie).
- Główny ekran: **pulpit z kartami** – pasek podsumowania i karty urządzeń z mini-wykresami.
- Menu nawigacji **po lewej**, zwijane do ikon; na telefonie chowane pod przyciskiem.

## Układ aplikacji

```
┌──────────────────────────────────────────────────────────────┐
│ NetPulse   [odświeżanie ▾] [zakres czasu ▾]      Jan K. ▾    │  pasek górny
├────────────┬─────────────────────────────────────────────────┤
│ Dashboard  │                                                 │
│ Ustawienia │              widoki / widgety                   │
│   Konto    │                                                 │
│   Urządz.  │                                                 │
│   Odśw.    │                                                 │
│   Aktualiz.│                                                 │
└────────────┴─────────────────────────────────────────────────┘
```

- **Pasek górny:** kto jest zalogowany; rozwijane menu konta (Ustawienia konta, Wyloguj);
  globalny wybór interwału odświeżania i zakresu czasu.
- **Menu:** na start `Dashboard` i `Ustawienia`. W Ustawieniach: `Konto`, `Urządzenia`
  (dodawanie z testem SNMP, edycja, usuwanie), `Odświeżanie`, `Aktualizacja`.
- Nowa sekcja (Alerty, Topologia, Klienci WiFi…) = jeden wpis w rejestrze modułów
  (ścieżka, ikona, nazwa, wymagana rola) – bez zmian w układzie aplikacji.

## Widgety i personalizacja wykresów

Pulpit składa się z **widgetów**. Widget to `{ typ, konfiguracja }` zapisana jako JSON
(z numerem wersji schematu), więc ta sama definicja nadaje się później do aplikacji mobilnej.

| Typ widgetu       | Co pokazuje                                          |
|-------------------|------------------------------------------------------|
| `summary`         | podsumowanie sieci (urządzenia, ruch WAN, klienci)   |
| `device-card`     | karta urządzenia: status, mini-wykres, porty         |
| `traffic-chart`   | ruch na wybranych portach (in/out)                   |
| `device-chart`    | CPU, RAM, load urządzenia                            |
| `wifi-chart`      | klienci i ruch sieci WiFi                            |
| `port-table`      | tabela portów ze statusem i prędkością               |

Personalizacja wykresu (per widget): tytuł, źródło danych (urządzenie, port, metryka),
zakres czasu, typ (linia, obszar, słupki), kolory serii, jednostki (bit/s lub B/s),
wygładzanie, skala osi, własny interwał odświeżania. Układ pulpitu (kolejność, rozmiar,
dodawanie i usuwanie widgetów) edytowany przeciąganiem. Zapisywane **na koncie użytkownika**
w bazie (nie w przeglądarce), więc działa na każdym urządzeniu.

## Odświeżanie

- Globalny interwał w pasku górnym: wyłączone, 5 s, 10 s, 30 s, 1 min, 5 min (domyślnie 30 s),
  plus przycisk „Odśwież teraz”. Zakres czasu wykresów (15 min – 7 dni) wybiera się na Dashboardzie.
  Każdy widget będzie mógł mieć własny interwał (etap 5e).
- Na razie wybór jest zapamiętywany w przeglądarce; zapis na koncie użytkownika dochodzi
  razem z personalizacją (5e).
- Odświeżanie wstrzymuje się, gdy karta przeglądarki jest w tle.
- Kolektor odpytuje urządzenia co `NETPULSE_POLL_INTERVAL` (domyślnie 30 s), więc odświeżanie
  częstsze niż interwał kolektora nie da nowych danych – panel to zaznaczy.
- Później: WebSocket (dane „na żywo” bez odpytywania).

## Aktualizacja jednym kliknięciem

Decyzja: **osobny kontener `updater`**. Samo API nie dostaje dostępu do Dockera.

```
panel ──(admin)──► API ──(sieć wewnętrzna, token)──► updater ──► docker compose pull/up
                    │                                  │
                    └──── sprawdza wersję ◄────────────┘ źródło wydań
```

1. API sprawdza najnowsze wydanie w **źródle aktualizacji** i porównuje z zainstalowaną wersją.
   Źródło jest ustawieniem (`NETPULSE_UPDATE_SOURCE`), domyślnie wydania GitHub; później można
   wskazać własny serwer (chmura, subskrypcje) o tym samym formacie manifestu
   (`wersja`, `lista zmian`, `obrazy`).
2. Zakładka **Ustawienia → Aktualizacja** pokazuje: zainstalowana wersja, dostępna wersja,
   lista zmian i przycisk **Aktualizuj** (tylko administrator, z potwierdzeniem).
3. Kliknięcie → API zleca updaterowi aktualizację; panel pokazuje postęp i po restarcie
   usług sam się odświeża.
4. Updater nasłuchuje wyłącznie w sieci wewnętrznej Dockera, wymaga tokenu, potrafi tylko
   ustalone akcje (sprawdź, zaktualizuj, status), a obrazy bierze wyłącznie ze skonfigurowanego źródła.
5. Przed aktualizacją: kopia bazy (`pg_dump`) i możliwość powrotu do poprzedniej wersji, gdy
   nowa nie wystartuje.

Uwaga bezpieczeństwa: dostęp do gniazda Dockera jest równoważny uprawnieniom roota na
serwerze. Dlatego jest wyłącznie w małym, osobnym kontenerze z minimalną powierzchnią,
a ustawienie można wyłączyć (`NETPULSE_UPDATER=off`) – wtedy panel pokazuje tylko komunikat
o nowej wersji i komendę `netpulse update`.

Warunek wstępny: **gotowe obrazy w rejestrze (GHCR)** zamiast budowania na serwerze użytkownika.

## Przygotowanie pod chmurę, aplikację mobilną i powiadomienia

Nie budujemy tego teraz, ale unikamy decyzji, które by to blokowały:

- **API-first:** panel używa tylko publicznego API; schemat OpenAPI służy do generowania
  klientów (mobilny, chmura). API dostanie prefiks wersji (`/api/v1`) przed pierwszym wydaniem publicznym.
- **Logowanie dla aplikacji mobilnej:** dziś sesja w ciasteczku (przeglądarka). Dojdą
  **tokeny dostępu** (osobne dla urządzeń/aplikacji, do odwołania w panelu) obok ciasteczek.
- **Zdarzenia i powiadomienia:** alerty (krok 8) i „dostępna aktualizacja” trafiają do
  jednego modelu **zdarzeń**; kanały dostarczania to wymienne wtyczki: w panelu, e-mail/webhook,
  push do aplikacji mobilnej (przez przekaźnik w chmurze).
- **Identyfikator instalacji:** każda instalacja ma losowy `instance_id` – potrzebny do
  późniejszego powiązania z chmurą, bez wysyłania czegokolwiek bez zgody użytkownika.
- **Role:** dziś każde konto jest administratorem; model użytkownika ma już `is_admin`,
  dojdzie rola tylko-do-odczytu (np. do wyświetlacza na ścianie).
- **Bez telemetrii:** instalacja niczego nie wysyła na zewnątrz poza sprawdzaniem wydań.

## Technologia

| Warstwa       | Wybór                                                                 |
|---------------|-----------------------------------------------------------------------|
| Aplikacja     | React 19 + TypeScript, Vite, React Router                             |
| Wygląd        | Tailwind CSS, motyw ciemny/jasny przez zmienne CSS, ikony Tabler      |
| Dane          | TanStack Query (odświeżanie, cache), klient generowany z OpenAPI      |
| Wykresy       | Apache ECharts                                                        |
| Układ pulpitu | react-grid-layout (przeciąganie i zmiana rozmiaru widgetów)           |
| Tłumaczenia   | i18n od początku (domyślnie polski, angielski później)                |
| Dostarczanie  | Node tylko w etapie budowania obrazu; gotowe pliki serwuje kontener API |

## Etapy budowy (krok 5)

| Etap | Zakres                                                                                     |
|------|--------------------------------------------------------------------------------------------|
| 5a ✅ | Szkielet aplikacji: pasek górny, menu, motyw, ekran logowania z kreatorem, wbudowanie w obraz API |
| 5b ✅ | Dashboard: pasek podsumowania, karty urządzeń, wykres ruchu, interwały odświeżania          |
| 5c   | Ustawienia: Konto (zmiana hasła), Urządzenia (dodaj/edytuj/usuń z testem SNMP), Odświeżanie |
| 5d   | Aktualizacja: sprawdzanie wersji, kontener updater, przycisk Aktualizuj (wymaga obrazów GHCR) |
| 5e   | Personalizacja: edytor widgetów, układ pulpitu, opcje wykresów zapisywane na koncie         |

Przed pierwszym wydaniem publicznym dodatkowo: migracje bazy (Alembic), prefiks `/api/v1`,
obrazy w GHCR, licencja i README dla obcych użytkowników.
