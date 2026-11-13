# Język angielski (etap 4)

Etap 4 planu (`docs/40-plan-dzialania.md`) podzielony na trzy części:

| Część | Zakres | Stan |
|---|---|---|
| **4a** | Panel po angielsku: plik tłumaczeń, wybór języka, formaty dat i liczb | ✅ 0.74.0 |
| 4b | Komunikaty z backendu: błędy API jako kody, tytuły alertów, opisy źródeł danych, zdarzenia | do zrobienia |
| 4c | Powiadomienia (e-mail, Telegram, ntfy), raport PDF/CSV, aplikacja Android | do zrobienia |

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

Co zostaje po polsku do części 4b: tekst, który przychodzi z API – tytuły alertów („Dysk /mnt/data zajęty w 91 %”),
komunikaty błędów (`HTTPException` z polskim `detail`), opisy źródeł w „Potwierdzenie danych” (`verification.py`),
nazwy z raportu miesięcznego. Dlatego test stron pomija Raporty i Ustawienia → System.
