# Język angielski (etap 4)

Etap 4 planu (`docs/40-plan-dzialania.md`) podzielony na trzy części:

| Część | Zakres | Stan |
|---|---|---|
| **4a** | Panel po angielsku: plik tłumaczeń, wybór języka, formaty dat i liczb | ✅ 0.74.0 |
| **4b** | Komunikaty z backendu: błędy API, walidacja, tytuły i opisy alertów, opisy źródeł danych, usługa aktualizacji | ✅ 0.75.0 |
| **4c** | Powiadomienia (e-mail, Telegram, ntfy, webhook), raport PDF/CSV, aplikacja Android | ✅ 0.76.0 (Android 0.3.0) |

## 4a – panel (0.74.0)

- **Teksty**: `frontend/src/i18n/pl.ts` (źródło kluczy) i `en.ts` (`Record<TextKey, string>` – brak klucza to błąd
  typów, więc `npm run typecheck` w CI go wyłapie). Nowy tekst = wpis w obu plikach. Nowy język = plik z tymi samymi
  kluczami i wpis w `LANGUAGES` / `TEXTS` / `LOCALES` w `i18n/index.ts`.
- **Wybór języka**: Ustawienia → Konto i lista na stronie logowania. Zapamiętany w przeglądarce (`netpulse.language`,
  jak motyw); bez wyboru – język przeglądarki (`pl*` = polski, inne = angielski). Zmiana przeładowuje panel, bo teksty
  są czytane przy renderowaniu i w stałych modułów. `<html lang>` ustawia `i18n/index.ts`.
  Język jest na przeglądarkę, a nie na konto – tak jak motyw i odświeżanie. Język powiadomień i raportów (4c) będzie
  ustawieniem serwera.
- **Daty i liczby**: `lib/intl.ts` (`dateFormat`, `numberFormat`, `formatNumber`) – formatery w bieżącym języku
  (polski `pl-PL`, angielski `en-GB`: zegar 24-godzinny, data dzień/miesiąc). **Nowe formatowanie = `lib/intl.ts`
  albo `locale()` z `i18n`, nie `"pl"` wpisane w kod.**
- **Teksty wpisane w kod** przeniesione do kluczy: dziennik zdarzeń (`audit.*`), gotowe sprawdzenia (`chk.preset.*`),
  jednostki (`unit.*`), nazwy miesięcy (`month.*`), „przed chwilą”, „2,4 GHz”, tytuł zgłoszenia urządzenia.
- **Testy**: `src/i18n/English.test.tsx` – każdy klucz, te same zmienne `{…}`, bez polskich znaków w `en.ts`, formaty,
  przełączenie na stronie logowania i 18 stron panelu wyrenderowanych po angielsku bez polskiego tekstu.
  Pozostałe testy pracują po polsku (`test/setup.tsx` ustawia `pl`).

Teksty z API (tytuły alertów, błędy, opisy źródeł danych) tłumaczy backend – część 4b. Test stron panelu dalej pomija
Raporty i Ustawienia → System, bo atrapa API (`test/mockApi.ts`) odpowiada po polsku.

## 4b – komunikaty z backendu (0.75.0)

- **Zasada**: backend dalej pisze komunikaty po polsku (kod, baza, testy bez zmian). Panel wysyła w każdym żądaniu
  `Accept-Language` z wybranym językiem (`languageHeaders()` w `lib/api.ts`). Dla angielskiego `LanguageMiddleware`
  (`backend/netpulse/i18n.py`) tłumaczy wszystkie teksty w odpowiedziach JSON pod `/api` (bez kluczy słowników).
  Bez nagłówka albo z innym językiem – po polsku, jak dotąd (Android, `curl`, stare panele).
- **Katalog**: `backend/netpulse/messages.py` – pary (polski wzorzec, angielski wzorzec). `{nazwa}` dopasowuje dowolny
  tekst, który też jest tłumaczony (np. „Warunek: {metric} {op} {num}” → opis metryki z katalogu); `{num…}` to liczba
  z jednostką (przecinek → kropka, „dni” → „days”), `{op}` to `<`/`>`. Tekst wielowierszowy – wiersz po wierszu.
  Tekst spoza katalogu (nazwy urządzeń, odpowiedzi urządzeń, błędy bibliotek) przechodzi bez zmian.
- **Dzięki wzorcom bez migracji**: tytuły zapisanych alertów, `last_error` urządzeń i sprawdzeń, dziennik usługi
  aktualizacji tłumaczą się przy odczycie, także te sprzed aktualizacji.
- **Walidacja**: komunikat Pydantic „Value error, …” – tłumaczona jest część po przecinku, panel obcina przedrostek.
- **Pominięte ścieżki**: `/metrics` (serie liczb), `/api/live` (WebSocket), `/api/agent/v1/`; odpowiedzi nie-JSON
  (CSV, PDF, pliki kopii) i większe niż 4 MB.
- **Nowy komunikat = wpis w `messages.py`.** `tests/test_i18n.py::test_every_polish_message_is_in_catalog` skanuje kod
  backendu i usługi aktualizacji (stałe i f-stringi, bez logów, docstringów i opisów OpenAPI) i sprawdza, że każdy polski
  tekst się tłumaczy. Komunikat składany z kawałków („Podaj adres” + „ webhooka”) trzeba pisać w całości – inaczej
  wzorzec go nie złapie. Poza zakresem testu: `cli.py`, agent i migracje (teksty w terminalu serwera).

## 4c – powiadomienia, raport, Android (0.76.0)

- **Powiadomienia**: język wiadomości to **ustawienie serwera** (powiadomienia wysyła kolektor, bez przeglądarki):
  Ustawienia → Powiadomienia → „Język powiadomień”, wspólny dla wszystkich kanałów. Zapis w `app_settings`
  (klucz `language`, `i18n.server_language`), API `GET|PUT /api/notification-channels/language` (zmiana – administrator).
  Domyślnie polski, więc istniejące instalacje bez zmian. `notifications.py` tłumaczy tytuł i opis zdarzenia
  (`localized`) i stałe teksty („Zakończono: …”, podsumowania, ciche godziny, wiadomość próbna) – katalogiem `messages.py`.
- **Raport PDF/CSV**: w języku panelu – linki pobierania mają `&lang=<język panelu>` (bez parametru: `Accept-Language`).
  Po angielsku: nazwy miesięcy, nagłówki i opisy z katalogu, liczby z kropką, daty `RRRR-MM-DD GG:MM`, CSV z przecinkiem
  (po polsku dalej średnik i przecinek dziesiętny – Excel po polsku), plik `uplinkview-report-RRRR-MM`. Podgląd raportu
  w panelu (JSON) tłumaczy middleware jak resztę API.
- **Aplikacja Android 0.3.0**: teksty w zasobach – `res/values/strings.xml` (angielski: każdy język telefonu poza
  polskim) i `res/values-pl/strings.xml` (polski); **nowy tekst = wpis w obu plikach**. Język wybiera system według
  języka telefonu. Aplikacja wysyła `Accept-Language` (pl/en), więc komunikaty serwera (np. błąd logowania) są w tym
  samym języku; liczby z separatorem dziesiętnym języka telefonu.

Zostaje po polsku: CLI na serwerze (`netpulse …`), instalator, agent Linux i jego `install.sh`, dziennik zdarzeń
(akcje są kodami, panel je tłumaczy), nazwy nadane przez użytkownika.
