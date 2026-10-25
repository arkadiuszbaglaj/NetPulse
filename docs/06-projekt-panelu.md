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
| Monitorowanie serwerów Linux | Serwer jako urządzenie w panelu: CPU, RAM, dyski, obciążenie, sieć. Etap 1 przez SNMP (`snmpd`), etap 2 własny agent z usługami systemd, kontenerami Docker i SMART. | Dashboard (karty), Ustawienia → Urządzenia, alerty | 2026-10-24 |
| Alerty w panelu | Reguły z progami (np. ruch, błędy, CPU/RAM, zajętość dysku, port down, urządzenie offline), lista aktywnych i historii alertów, wskaźnik w pasku górnym. To rozwinięcie etapu 8. | Pasek górny (dzwonek), nowa sekcja Alerty, Ustawienia → Alerty | 2026-10-24 |
| Stan serwera NetPulse | Parametry maszyny, na której działa aplikacja: CPU, RAM i swap, obciążenie, dyski (zajętość, miejsce pod bazę), czas pracy, temperatura, rozmiar bazy, stan usług NetPulse. Z historią na wykresach. | Dashboard (karta „Serwer”), Ustawienia → System | 2026-10-25 |
| Kreator dashboardów: prywatny i publiczny | Kreator tworzenia własnych dashboardów (nazwa lub szablon, wybór i układ widgetów, widoczność). **Prywatny** widzi tylko administrator po zalogowaniu, **publiczny** otwiera się pod osobnym adresem bez logowania (tylko do odczytu, np. wyświetlacz ścienny, podgląd dla domowników). | Dashboard (lista i przełącznik dashboardów), Ustawienia → Dashboardy, publiczna strona poza powłoką aplikacji | 2026-10-25 |
| Powiadomienie o aktualizacji w pasku górnym ✅ wdrożone (2026-10-25) | Po automatycznym, cyklicznym sprawdzeniu wydań (bez klikania „Sprawdź”) pasek górny pokazuje wyraźną informację, że jest nowa wersja (np. plakietka „Dostępna aktualizacja 0.7.0” z linkiem do Ustawienia → Aktualizacje), żeby użytkownik nie przegapił, gdy zapomni zajrzeć. Wymaga cyklicznego sprawdzania po stronie API (np. co kilka godzin) i zapamiętania wyniku; można dać „odłóż/ukryj tę wersję”. W Ustawienia → Aktualizacje przełącznik **„Automatycznie sprawdzaj aktualizacje”** (domyślnie włączony; po wyłączeniu nic nie jest odpytywane i pasek nie pokazuje plakietki, zostaje ręczne „Sprawdź”) oraz wybór częstotliwości sprawdzania; ustawienie na poziomie instalacji, nie konta, bo sprawdza API. Po wprowadzeniu alertów (etap 8) ta sama informacja trafi też do dzwonka. | Pasek górny, Ustawienia → Aktualizacje | 2026-10-25 |

### Szczegóły: kreator dashboardów (prywatny i publiczny)

- **Kreator (kroki):** 1) nazwa i szablon wyjściowy (np. „Pełny przegląd”, „Tylko ruch WAN”, „Status urządzeń”,
  „Wyświetlacz ścienny”, pusty); 2) wybór i układ widgetów z rejestru widgetów (ten sam co w etapie 5e);
  3) widoczność: **Prywatny** (tylko administrator) albo **Publiczny** (bez logowania) z opcjami prywatności;
  4) podsumowanie z linkiem do skopiowania i kodem QR. Edycja później tym samym kreatorem.
- **Publiczny dashboard:** adres w osobnej przestrzeni (np. `/p/<losowy-token>`), strona bez menu i paska
  użytkownika, tylko odczyt. Link z nieodgadywalnym tokenem, który można w każdej chwili **unieważnić lub wymienić**,
  opcjonalna data wygaśnięcia i opcjonalne hasło (PIN). Tryb ekranu pełnego bez elementów sterujących
  (wyświetlacz ścienny, telewizor), z odświeżaniem nie częściej niż co 10 s.
- **Bezpieczeństwo (to jest sedno pomysłu):**
  - Osobny, **tylko do odczytu** interfejs API dla publicznych dashboardów (np. `/api/public/dashboards/{token}`),
    który zwraca wyłącznie dane widgetów wybranych w tym dashboardzie. Nie korzysta z ciasteczek sesji
    i nie wystawia pozostałego API. Lista dozwolonych widgetów jest jawna (biała lista), a nowe widgety są
    domyślnie niedostępne publicznie, dopóki ktoś ich nie oznaczy.
  - **Opcje prywatności publicznego widoku:** ukryj adresy IP i MAC, nazwy sieci WiFi i opisy portów,
    zaokrąglij wartości, nie pokazuj błędów urządzeń. Domyślnie wszystko ukryte. Publiczny widok nigdy nie
    pokazuje community, haseł, tokenów, wersji oprogramowania ani informacji o aktualizacjach.
  - **Globalny wyłącznik** w Ustawienia → Dashboardy: „Zezwalaj na dashboardy publiczne”, **domyślnie wyłączony**.
    Dopóki nie jest włączony, kreator oferuje tylko prywatne.
  - Ograniczenie liczby żądań (per adres i per token), pamięć podręczna odpowiedzi (kilka sekund), żeby publiczny
    link nie obciążał serwera ani bazy; nagłówki `noindex`, `Cache-Control`, `Referrer-Policy: no-referrer`;
    osadzanie w `<iframe>` tylko po jawnym włączeniu (`frame-ancestors`).
  - Dziennik: kto, kiedy i który dashboard upublicznił, wymienił token albo wyłączył. Ostrzeżenie w kreatorze,
    że **publiczny link ujawnia dane o sieci każdemu, kto go ma**, oraz że panel nie powinien być wystawiony
    wprost do internetu: dostęp z zewnątrz tylko przez VPN albo reverse proxy z HTTPS.
- **Prywatny dashboard:** dostępny po zalogowaniu wyłącznie dla administratora. Gdy pojawią się role (tylko do
  odczytu), prywatny może być współdzielony z wybranymi użytkownikami; to osobna decyzja.
- **Model danych:** nowa tabela `dashboards` (nazwa, właściciel, widoczność, token publiczny, ustawienia
  prywatności, wygaśnięcie, skrót hasła, JSON z układem i widgetami w wersjonowanym schemacie z etapu 5e).
  Nowa tabela powstaje sama przy `netpulse update` (bez migracji Alembic). Ten sam model posłuży aplikacji
  mobilnej i widgetom.
- **Zależności:** etap 5e (rejestr widgetów, edytor układu, zapis na koncie), etap 5f (tryb „Na żywo” może
  napędzać wyświetlacz ścienny), ograniczanie liczby żądań w API (nie ma go jeszcze).
- **Decyzje do podjęcia:** czy publiczny link ma być chroniony tylko tokenem, czy domyślnie także hasłem;
  które widgety mogą być publiczne w pierwszej wersji (na start np. podsumowanie, ruch WAN, liczba klientów
  WiFi, stan urządzeń bez adresów); czy dopuścić wiele publicznych dashboardów naraz; czy dashboard główny
  (domyślny po zalogowaniu) też jest jednym z dashboardów kreatora.

### Szczegóły: stan serwera NetPulse

- **Skąd dane:** kontener czyta `/proc` (CPU, RAM, obciążenie, czas pracy pokazują wartości całego serwera,
  nie kontenera), `/sys` (temperatura, jeśli system ją udostępnia) i zajętość dysku. Bez SNMP i bez agenta.
- **Historia:** próbka co cykl kolektora (30 s) do **nowej tabeli** metryk systemowych (nowa tabela powstaje
  sama przy `netpulse update`, więc nie wymaga migracji Alembic); wykresy i interwały jak na Dashboardzie.
- **Zakres:** CPU %, obciążenie 1/5/15 min, RAM i swap, dyski (root i dysk z danymi Dockera), czas pracy,
  temperatura, rozmiar bazy i jej przyrost, czas ostatniego cyklu kolektora, stan usług (api, kolektor, baza,
  updater). Stan kontenerów podaje `updater` (jedyny z dostępem do Dockera) w osobnej akcji tylko do odczytu.
- **Panel:** karta „Serwer” na Dashboardzie (CPU, RAM, dysk z paskiem zapełnienia) i podstrona
  Ustawienia → System ze szczegółami i wykresami.
- **Ograniczenia:** inne dyski niż ten z Dockerem widać tylko po dodatkowym zamontowaniu (tylko do odczytu);
  temperatury nie ma na części maszyn wirtualnych.
- **Powiązania:** pierwszy krok do pozycji „Monitorowanie serwerów Linux” (ten sam model danych posłuży innym
  serwerom), ostrzeżenia typu „dysk > 90%” wejdą w alerty (etap 8). Pomysł z rozmowy o błędzie „brak miejsca
  na dysku” przy aktualizacji.

### Szczegóły: alerty w panelu

- **Reguła** = metryka + warunek + próg + czas trwania + ważność. Przykłady: „ruch WAN pobierania
  > 800 Mb/s przez 5 min”, „błędy na porcie rosną”, „CPU > 90% przez 10 min”, „RAM > 85%”,
  „dysk > 90%”, „port przeszedł w stan down”, „urządzenie nie odpowiada 2 minuty”,
  „spadek liczby klientów WiFi do 0”.
- **Stany alertu:** wyzwolony → potwierdzony (przez użytkownika) → zakończony, z historią
  (kiedy, jak długo, jaka wartość szczytowa). Histereza i minimalny czas trwania, żeby krótkie
  skoki nie sypały alertami.
- **Panel:** dzwonek w pasku górnym z licznikiem aktywnych, sekcja **Alerty** (aktywne i historia,
  filtr po ważności i urządzeniu), formularz reguł w Ustawienia → Alerty z gotowymi szablonami
  („urządzenie offline”, „port down”, „wysokie CPU”). Z poziomu wykresu: „utwórz alert z tego
  progu” (linia progu rysowana na wykresie).
- **Silnik:** ocena reguł po każdym cyklu kolektora, na ogólnych metrykach (wymóg wstępny jak przy
  serwerach Linux), żeby ta sama reguła działała dla sieci i dla serwerów. Zapis zdarzeń w jednym
  modelu zdarzeń, wspólnym z powiadomieniami o aktualizacjach.
- **Powiadomienia:** w panelu (od razu), potem kanały jako wtyczki: e-mail, webhook, push do aplikacji
  mobilnej (przez chmurę). Ciche godziny i grupowanie, żeby awaria switcha nie dała dwudziestu wiadomości.
- **Decyzje do podjęcia:** czy progi mają być bezwzględne, czy też względem normy (np. „2× więcej niż
  zwykle o tej porze”); czy reguły domyślne włączać od razu po instalacji (np. offline i port down).
- **Zależności:** migracje Alembic i ogólna tabela metryk (jak w opisie serwerów Linux), model
  zdarzeń i tokenów pod aplikację mobilną.

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

### Szczegóły: monitorowanie serwerów Linux

Rozszerzenie NetPulse z urządzeń sieciowych na serwery. Cel: sieć i serwery w jednym lekkim panelu,
z tą samą instalacją jednym linkiem. Dwa etapy, od najtańszego.

**Etap A – SNMP (`snmpd` na serwerze).**
- Kolektor już czyta UCD-SNMP-MIB (CPU, RAM, load) i IF-MIB (interfejsy). Dochodzi `kind = server`
  oraz driver `linux`: dyski i partycje (HOST-RESOURCES-MIB `hrStorage` albo UCD `dskTable`),
  swap, liczba procesów, czas pracy.
- W panelu: karta serwera na Dashboardzie (CPU, RAM, dysk z paskiem zapełnienia) i dodawanie
  w Ustawienia → Urządzenia (typ „Serwer Linux”, podpowiedź, jak włączyć `snmpd`).
- Wygoda: opis konfiguracji `snmpd` (tylko odczyt, tylko z adresu serwera NetPulse) w dokumentacji.
- Ograniczenia SNMP: brak kontenerów, usług systemd, SMART i temperatur (poza tym, co wystawi `snmpd`).

**Etap B – własny agent (`netpulse-agent`).**
- Mały program lub kontener na monitorowanym serwerze, czyta `/proc` i `/sys`, wysyła metryki do NetPulse
  przez HTTPS z tokenem instalacji (**push**: działa za NAT-em, bez otwierania portów na serwerze, pasuje do chmury).
- Zakres: CPU (także na rdzeń), RAM i swap, dyski (zajętość, IO), sieć, temperatury, SMART,
  stan usług systemd, kontenery Docker (stan, zasoby). Bez logów i śledzenia procesów – to ma pozostać lekkie.
- Instalacja agenta jednym poleceniem pokazywanym w panelu (token wygenerowany w Ustawieniach, do odwołania).
- Odczyt kontenerów wymaga dostępu do gniazda Dockera: tylko do odczytu i opcjonalnie (podobne ryzyko jak updater).

**Wymagania wstępne w architekturze (zrobić przed etapem B, najlepiej razem z migracjami Alembic):**
- Ogólna tabela metryk (urządzenie, nazwa, etykiety, wartość) jako hypertable, obok dzisiejszych tabel
  z ustalonymi kolumnami (`interface_metrics`, `device_metrics`). Dyski, kontenery i usługi nie mieszczą się w stałych kolumnach.
- Alerty (etap 8) projektować od razu na ogólnych metrykach, żeby obejmowały sieć i serwery
  („dysk zapełniony w 90%”, „serwer nie odpowiada”, „kontener zatrzymany”).
- Model tokenów dostępu (już zaplanowany pod aplikację mobilną) obejmuje też tokeny agentów.

**Kolejność:** etap A po 5e (prawie bez nowej infrastruktury, od razu pokazuje, jak serwer wygląda w panelu),
etap B po alertach, przed albo razem z chmurą.
