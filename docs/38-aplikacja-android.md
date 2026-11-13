# Aplikacja na Androida

Aplikacja 0.1.0: logowanie do serwera UplinkView i ruch na porcie WAN; 0.2.0: widget „Ruch WAN” na ekran główny; 0.2.1: logowanie z serwerem 0.65.5+ przez HTTP (ciasteczko `netpulse_session_http`); 0.3.0: po angielsku albo po polsku według języka telefonu (`res/values`, `res/values-pl`); 0.4.0: nowa nazwa UplinkView (aktualizuje się na miejsce poprzedniej, `applicationId` bez zmiany). Kod: `mobile/android/`
(Kotlin + Jetpack Compose, bez dodatkowych bibliotek poza OkHttp).

## Co umie

- **Logowanie**: adres serwera, login i hasło. Gdy konto ma logowanie dwuskładnikowe, pojawi się pole kodu
  (kod z aplikacji albo kod zapasowy). Adres bez portu dostaje domyślny port instalatora `:8000`
  (`192.168.1.34` → `http://192.168.1.34:8000`); można też wpisać pełny adres, np. `https://netpulse.lan:8443`.
- **Ruch WAN**: karta każdego łącza WAN (stan: aktywne / zapas / brak łącza / brak danych, pobieranie i wysyłanie)
  i wykres historii ruchu WAN (1 h, 6 h, 24 h, 7 dni) – ten sam szereg co wykres ruchu WAN w panelu.
- **Na żywo**: gdy aplikacja jest na ekranie, odczyty idą co ~1,5 s (ten sam WebSocket co „Na żywo” w panelu);
  wykres i stan łączy odświeżają się co 30 s. W tle aplikacja nic nie pobiera.
- Motyw jasny i ciemny według ustawień telefonu, kolory wyglądu „Błękit” z panelu.

## Widget „Ruch WAN” (0.2.0)

- Dodanie: przytrzymaj palec na pustym miejscu ekranu głównego → Widżety → UplinkView → „Ruch WAN”.
- Mały (3×1, domyślny): łącze aktywne – pobieranie ↓ i wysyłanie ↑, kropka stanu, godzina odczytu.
  Po powiększeniu w pionie: wszystkie łącza WAN (do trzech), każde ze stanem.
- Odświeżanie: w tle co 15 min (najczęściej, jak Android pozwala – Samsung przy oszczędzaniu baterii potrafi
  to opóźnić), od razu po stuknięciu ikony ↻ na widgecie i przy każdym odświeżeniu ekranu WAN w aplikacji (co 30 s).
  Widget nie pokazuje odczytów „na żywo” – to wartości z kolektora (próbka co 30 s).
- Stuknięcie widgetu otwiera aplikację. Bez sieci domowej widget zostawia ostatnie wartości z dopiskiem
  „Brak połączenia · godzina”; po wylogowaniu albo wygaśnięciu sesji – „Zaloguj się w aplikacji”.
- Kod: `WanWidget.kt` (Glance), `WidgetData.kt` (odczyt, zapis stanu, WorkManager).

## Jak to działa z serwerem

Aplikacja nie wymaga zmian na serwerze – loguje się tak jak panel (`POST /api/auth/login`, ciasteczko
`netpulse_session`) i czyta `GET /api/wan/status`, `GET /api/dashboard/traffic?minutes=` oraz
`/api/live/device?device=` (WebSocket). Telefon pamięta adres, login i ciasteczko sesji, **nigdy hasła**.
Sesja trwa tyle, co w przeglądarce (`session_days`); po wygaśnięciu aplikacja wraca do logowania.
Wylogowanie w aplikacji usuwa sesję także na serwerze. Logowania z aplikacji widać w Dzienniku zdarzeń.

HTTP jest dozwolony (sieć domowa). HTTPS z certyfikatem lokalnego CA UplinkView działa po zainstalowaniu `ca.pem`
w telefonie (Ustawienia → Bezpieczeństwo → Inne ustawienia → Zainstaluj z pamięci → Certyfikat CA).

## Instalacja na telefonie

1. Na telefonie otwórz stronę wydań: https://github.com/uplinkview/uplinkview/releases – wydanie
   „UplinkView na Androida 0.1.0” (tag `android-v0.1.0`), plik `UplinkView-0.1.0.apk`.
2. Otwórz pobrany plik. Za pierwszym razem Android zapyta o zgodę na instalację z tego źródła
   (Samsung: przeglądarka / „Moje pliki” → Zezwalaj z tego źródła).
3. Play Protect może ostrzec o nieznanej aplikacji – „Zainstaluj mimo to”.
4. Aktualizacja: nowszy APK instaluje się na starszy, dane (adres, sesja) zostają.

Wymagany Android 8.0 lub nowszy.

## Budowanie i wydania

- Workflow `.github/workflows/android.yml` (zmiany w `mobile/android/`): `gradle assembleRelease` (Gradle 8.11.1,
  JDK 17), podpis kluczem z sekretów `NETPULSE_KEYSTORE_B64` (plik `.p12` w base64) i `NETPULSE_KEYSTORE_PASSWORD`.
  Na gałęziach bez sekretów – klucz debug (tylko sprawdzenie kompilacji). Na `main` – wydanie `android-v<wersja>`
  (istniejące dostaje nowy plik).
- **Nowa wersja aplikacji** = `appVersionName` i `appVersionCode` (+1) w `mobile/android/app/build.gradle.kts`.
  Bez podniesienia `appVersionCode` telefon nie zainstaluje aktualizacji.
- **Klucz podpisu** leży poza repo (`UplinkView-android-klucz/` obok projektu) i w sekretach GitHuba. Jego utrata =
  każda kolejna wersja wymaga odinstalowania aplikacji. Trzymać kopię.
- Na komputerze nie trzeba Android Studio – APK buduje GitHub Actions.

## Dalej (pomysły)

Lista urządzeń i alerty, powiadomienia (np. przez istniejący kanał ntfy albo sprawdzanie co 15 min), widget
na ekran główny z ruchem WAN, parowanie kodem QR i tokeny aplikacji zamiast ciasteczka.
