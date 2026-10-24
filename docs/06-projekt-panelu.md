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
- Prawdziwe „na żywo” (jak w UniFi) to osobny tryb – patrz niżej, „Tryb Na żywo”.

## Tryb „Na żywo” (po etapie 5c)

Cel: pobieranie i wysyłanie WAN odświeżane co 1–2 s, jak w panelu UniFi. Zwykłe odświeżanie
pokazuje średnie z odczytów kolektora (domyślnie co 30 s), więc nie może tego zastąpić.

- **Działanie:** dopóki ktoś ma otwarty Dashboard w trybie „Na żywo”, API co 1–2 s odpytuje
  tylko liczniki WAN (`ifHCInOctets`/`ifHCOutOctets` wybranych interfejsów) i wysyła wyliczoną
  prędkość do przeglądarki przez WebSocket. Gdy nikt nie patrzy, nic się nie odpytuje.
- **Bez zapisu do bazy:** próbki żyją w pamięci (panel trzyma ostatnie 1–5 minut do wykresu).
  Historię nadal zapisuje kolektor.
- **Wspólne odpytywanie:** wielu widzów (karty, urządzenia) = jedno odpytywanie routera.
  Prędkość liczona tym samym `CounterTracker` co w kolektorze (obsługa przepełnienia i resetu liczników).
- **W panelu:** przełącznik „Na żywo” przy wykresie ruchu WAN (obok zakresu czasu), duże liczby
  pobierania i wysyłania oraz wykres przesuwający się w czasie rzeczywistym; po utracie połączenia
  automatyczny powrót do zwykłego odświeżania.
- **Dalej:** ten sam mechanizm dla wybranego portu switcha (strona urządzenia, etap późniejszy).
- **Uwagi:** SNMP odświeża liczniki mniej więcej co sekundę, więc dokładność jest bliska UniFi,
  ale nie identyczna (UniFi czyta wewnętrzne liczniki routera). Autoryzacja WebSocketu tą samą
  sesją co reszta API; limit liczby jednoczesnych połączeń i minimalny interwał (1 s), żeby nie
  przeciążyć routera.
- **Szybka alternatywa już dziś:** krótszy `NETPULSE_POLL_INTERVAL` (np. 10 s) w `.env` –
  gęstsze wykresy, ale baza rośnie proporcjonalnie (10 s ≈ 3 razy więcej wierszy niż 30 s).

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
| 5c ✅ | Ustawienia: Konto (zmiana hasła), Urządzenia (dodaj/edytuj/usuń z testem SNMP), Odświeżanie |
| 5d   | Aktualizacja: sprawdzanie wersji, kontener updater, przycisk Aktualizuj (wymaga obrazów GHCR) |
| 5e   | Personalizacja: edytor widgetów, układ pulpitu, opcje wykresów zapisywane na koncie         |
| 5f   | Tryb „Na żywo”: WebSocket, ruch WAN co 1–2 s, wykres w czasie rzeczywistym (kolejność względem 5d/5e do ustalenia) |

Przed pierwszym wydaniem publicznym dodatkowo: migracje bazy (Alembic), prefiks `/api/v1`,
obrazy w GHCR, licencja i README dla obcych użytkowników.

## Pomysły na później (backlog)

Rubryka na pomysły, które jeszcze nie mają etapu. Dopisujemy tu nowe pomysły, a gdy któryś
dojrzeje, dostaje numer etapu w tabeli wyżej. Kolumna „Zgłoszone” pozwala wrócić do tematu,
gdy ktoś zapyta „co jeszcze chcieliśmy zrobić”.

| Pomysł | Opis | Gdzie w panelu | Zgłoszone |
|--------|------|----------------|-----------|
| Wskaźnik siły hasła | Przy ustawianiu i zmianie hasła pokazuje na żywo, czy hasło spełnia wymagania: liczba znaków, cyfry, wielkie litery, znaki specjalne (każdy warunek jako ✓/✗ pod polem, plus pasek siły). Ten sam komponent w kreatorze pierwszego konta i w Ustawienia → Konto. | Kreator konta, Ustawienia → Konto | 2026-10-24 |

### Szczegóły: wskaźnik siły hasła

- **Dziś:** backend wymaga tylko minimum 8 znaków (`backend/netpulse/auth.py`, `MIN_PASSWORD`),
  a panel pokazuje błąd dopiero po wysłaniu formularza.
- **Warunki do pokazania:** długość (np. min. 8, zalecane 12), cyfra, wielka litera, mała litera,
  znak specjalny. Lista warunków i progi mają być w jednym miejscu, żeby dało się je zmienić.
- **Decyzja do podjęcia:** czy to tylko podpowiedź dla użytkownika (zalecane na start,
  bo nie blokuje długich haseł z samych słów), czy twarda reguła egzekwowana także w backendzie
  (wtedy te same reguły w `auth.py` i w panelu, a `netpulse user passwd` stosuje je również).
- **Wskazówka techniczna:** komponent `PasswordRequirements` w `frontend/src/components/`,
  czysta funkcja oceny hasła w `src/lib/` z testami; teksty w `src/i18n/pl.ts`.
  Dostępność: wyniki warunków ogłaszane czytnikom ekranu (`aria-live="polite"`), nie tylko kolorem.
