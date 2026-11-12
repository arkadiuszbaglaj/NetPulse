# HTTPS panelu (0.62.0)

Od 0.62.0 panel jest dostępny przez HTTP **i** HTTPS:

| Adres | Port (`.env`) |
|---|---|
| `http://<serwer>:8000` | `NETPULSE_PORT` – jak dotąd (agenci i zakładki działają bez zmian) |
| `https://<serwer>:8443` | `NETPULSE_HTTPS_PORT` |

## Jak to działa

- Nowy kontener **`proxy`** (nginx, `deploy/proxy/`) przyjmuje oba porty i przekazuje ruch do API. API nie ma już
  własnego opublikowanego portu, więc nagłówkom `X-Forwarded-For` / `X-Forwarded-Proto` od proxy można wierzyć:
  dziennik zdarzeń i limit logowań widzą prawdziwy adres klienta, a ciasteczko sesji przez HTTPS ma flagę `Secure`.
  Proxy nadpisuje `X-Forwarded-For` (nie dopisuje), więc klient nie podrobi swojego adresu.
- Certyfikat wystawia skrypt `deploy/proxy/tls.sh` w katalogu **`<katalog instalacji>/deploy/tls`**:
  - `ca.pem` / `ca-key.pem` – **lokalne CA NetPulse** (10 lat, klucz tylko dla roota),
  - `server.pem` / `server-key.pem` – certyfikat panelu podpisany przez to CA (397 dni, odnawiany sam 30 dni przed końcem),
  - adresy w certyfikacie: `localhost`, `127.0.0.1`, `NETPULSE_TLS_NAMES` z `.env` (instalator i `netpulse update`
    wpisują nazwę i adresy IPv4 serwera, bez sieci Dockera) oraz adresy dopisane w panelu (`request/names`).
  - Co 30 s skrypt sprawdza, czy trzeba wystawić nowy certyfikat (nowe adresy, koniec ważności), i przeładowuje nginx.
- Katalog `deploy/tls` jest w `.gitignore`; kopia zapasowa bazy go nie obejmuje (CA zostaje na dysku serwera).

## Panel: Ustawienia → System → HTTPS

- czy bieżące połączenie jest szyfrowane, link „Otwórz przez HTTPS”,
- rodzaj certyfikatu, ważność, adresy, odcisk SHA-256 CA (do porównania po imporcie),
- **„Pobierz certyfikat CA”** (`GET /api/system/tls/ca.pem`, bez klucza) i instrukcja importu (Windows, macOS, Linux,
  Firefox, telefon) – po imporcie przeglądarka nie ostrzega,
- gdy panel otwarto pod adresem, którego nie ma w certyfikacie: ostrzeżenie i (administrator) „Dodaj ten adres”;
  dodatkowe adresy (`PUT /api/system/tls/names`, tylko administrator) – nowy certyfikat w ciągu ~30 s.

## Własny certyfikat

Wgraj pełny łańcuch i klucz jako `deploy/tls/custom/cert.pem` i `deploy/tls/custom/key.pem` (np. z Let's Encrypt
albo firmowego CA). Proxy użyje ich w ciągu 30 s; gdy klucz nie pasuje do certyfikatu, zostaje certyfikat lokalnego CA
(wpis w `netpulse logs proxy`). Usunięcie plików przywraca certyfikat lokalnego CA.

## Sesja przez HTTP i HTTPS (0.65.5)

Ciasteczko sesji ma dwie nazwy: `netpulse_session` przez HTTPS (z flagą Secure) i `netpulse_session_http` przez HTTP.
Wcześniej była jedna nazwa i po zalogowaniu przez `https://…:8443` przeglądarka nie pozwalała panelowi pod
`http://…:8080` nadpisać tego ciasteczka (porty go nie rozdzielają), a przez HTTP go nie wysyłała – logowanie się
udawało, a panel wracał do ekranu logowania. Serwer czyta obie nazwy (najpierw tę dla protokołu), więc sesje sprzed
0.65.5 i aplikacja Android 0.2.0 dalej działają; od 0.2.1 aplikacja przyjmuje obie. Kod: `api/security.py`
(`cookie_name`, `session_token`), test: `tests/test_session_cookie.py`.

## Nagłówki bezpieczeństwa i dokumentacja API (0.65.6)

Każda odpowiedź API i panelu ma `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`,
`Referrer-Policy: same-origin` i `Content-Security-Policy: frame-ancestors 'self'; base-uri 'self'; object-src 'none';
form-action 'self'` – panelu nie da się osadzić w obcej stronie i podsunąć kliknięć (clickjacking). Odpowiedź może
ustawić własną wartość (pulpit publiczny: `Referrer-Policy: no-referrer`). Kod: `SECURITY_HEADERS` w `api/__init__.py`.

Dokumentacja API (`/docs`, `/openapi.json`) i numer wersji (`/api/auth/status`) są tylko dla zalogowanych;
`/api/health` (healthcheck Dockera, instalator) odpowiada bez wersji. Dymek wykresu zamienia nazwy serii (nazwy
kontenerów, maszyn, etykiety) na tekst – wcześniej nazwa z HTML-em mogła uruchomić skrypt w panelu
(`tooltipHtml` w `components/charts/panelData.ts`).

## Kod

`deploy/proxy/` (Dockerfile, `nginx.conf`, `proxy-common.conf`, `tls.sh`), `backend/netpulse/tls.py`,
`backend/netpulse/api/tls.py`, panel: `frontend/src/components/HttpsCard.tsx`. Testy: `tests/test_tls.py`,
`tests/test_scripts.py` (adresy z instalatora), krok „HTTPS przez proxy” w CI.

## Jak sprawdzić

1. `netpulse update`, potem `netpulse status` – jest usługa `proxy`.
2. Otwórz `https://<adres serwera>:8443` – przeglądarka ostrzeże (CA jeszcze nie jest zaufane), przejdź dalej.
3. Ustawienia → System → HTTPS → „Pobierz certyfikat CA”, zaimportuj go według instrukcji i otwórz stronę ponownie –
   kłódka bez ostrzeżeń.

## Utwardzenie (wersja 0.68.0)

Etap 2 planu z `docs/40-plan-dzialania.md` – część, która nie wymaga decyzji o kluczu podpisującym.

### Pełny Content-Security-Policy

Każda odpowiedź ma teraz pełną politykę treści (`content_security_policy` w `api/web.py`), nie tylko `frame-ancestors`:

| Dyrektywa | Wartość | Po co |
|-----------|---------|-------|
| `default-src` | `'self'` | wszystko tylko z adresu panelu |
| `script-src` | `'self'` + skrót skryptu motywu | wstrzyknięty skrypt (XSS) się nie wykona; bez `'unsafe-inline'` i `'unsafe-eval'` |
| `style-src` | `'self' 'unsafe-inline'` | style w atrybutach – potrzebne wykresom i siatce pulpitu |
| `img-src` | `'self' data: blob:` | kod QR, eksport wykresu do PNG |
| `connect-src` | `'self'` | API i WebSocket „Na żywo” – dane nie wyjdą na obcy serwer |
| `font-src`, `worker-src`, `manifest-src` | `'self'` (+ `data:` / `blob:`) | czcionki z paczki, manifest PWA |
| `frame-ancestors`, `base-uri`, `object-src`, `form-action` | jak dotąd | clickjacking, podmiana adresu bazowego, wtyczki |

Skrót skryptu wpisanego w `index.html` (ustawienie motywu przed pierwszym renderem) API liczy przy starcie ze zbudowanego
pliku (`panel_script_hashes`) – zmiana skryptu nie wymaga zmiany nagłówka. Strona `/docs` (Swagger UI, po zalogowaniu)
ma własną, luźniejszą politykę (`DOCS_CSP`), bo ładuje skrypt i style z `cdn.jsdelivr.net`.

**Nowy zasób spoza panelu (obraz, czcionka, skrypt z obcego adresu) = dopisać źródło w `content_security_policy`** –
inaczej przeglądarka go zablokuje. Sprawdzenie w przeglądarce bez serwera: `npm run build`, `npm run mock`
i `node dev/csp-preview.mjs` w `frontend/` (albo konfiguracja `panel-csp` w `.claude/launch.json`) – zbudowany panel
z tą samą polityką; naruszenia widać w konsoli przeglądarki. Sprawdzone 12.11.2026: pulpit, mapa sieci, urządzenie,
klienci, alerty, raporty, konto, system, dashboardy, paleta poleceń – bez naruszeń. Nie sprawdzone tą drogą: dane
„Na żywo” (atrapa nie ma WebSocketu) i pulpit publiczny.

### Limit logowań na konto

Obok limitu na adres IP (10 nieudanych prób / 15 min) jest limit na konto: 20 nieudanych prób / 15 min niezależnie
od adresu (`USER_MAX_FAILURES`, klucz `user:<login>` w `LoginLimiter`). Zgadywanie hasła z wielu adresów naraz albo zza
wspólnego reverse proxy nie omija już limitu. Blokada konta **nie dotyczy adresu, z którego to konto niedawno się
zalogowało** (30 dni albo do restartu API) – ktoś, kto zgaduje hasło administratora, nie odcina go od panelu na jego
własnym komputerze. Po restarcie API liczniki i znane adresy są puste.

### Kontenery

`deploy/docker-compose.yml`: wszystkie usługi mają `no-new-privileges`; API i kolektor (zwykły użytkownik, uid 10001)
mają odebrane wszystkie uprawnienia jądra (`cap_drop: ALL`); baza i proxy zostawiają tylko te, bez których nie wystartują
(`CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETGID`, `SETUID`, proxy także `KILL`). Updater ma gniazdo Dockera, czyli i tak pełną
kontrolę nad serwerem – dostał tylko `no-new-privileges`. System plików tylko do odczytu (`read_only`) nie jest włączony.

### Przypięte wersje

- **Baza:** `timescale/timescaledb:2.32.0-pg17` zamiast `latest-pg17` (też w CI). Przy `netpulse update` Docker pobiera
  ten obraz, a `init_db` aktualizuje rozszerzenie w bazie (`update_timescale_extension`: `ALTER EXTENSION timescaledb UPDATE`
  jako pierwsze polecenie świeżego połączenia; w logu kolektora „Rozszerzenie TimescaleDB w bazie: …”).
  **Wersji nie obniżać** – baza nie cofnie rozszerzenia. Podniesienie = zmiana w `docker-compose.yml` i `ci.yml`.
- **Python:** `backend/requirements.lock` – dokładne wersje wszystkich bibliotek ze skrótami SHA-256; obraz buduje się
  z `pip install --require-hashes`. Po zmianie zależności w `pyproject.toml` odświeżyć plik (z katalogu `backend/`):
  `uv pip compile pyproject.toml requirements-build.in --universal --generate-hashes --python-version 3.13 --no-header -o requirements.lock`
  Testy w CI instalują zależności z `pyproject.toml` (bez pliku blokady); obraz Dockera sprawdza test end-to-end.

### Czego w 0.68.0 nie ma (z etapu 2)

- **Podpisane aktualizacje** – wymagają klucza, który tworzy i trzyma użytkownik; do decyzji.
- **Osobna rola bazy bez uprawnień superużytkownika** – odłożona po analizie: przywracanie kopii zapasowej i tak
  musi działać jako superużytkownik (wymaga tego TimescaleDB), więc osobna rola nie zamyka drogi „wgrana kopia wykonuje
  kod”. Kopię wgrywa tylko administrator, który i tak może zainstalować dowolną wersję NetPulse. Zysk byłby tylko przy
  błędzie typu SQL injection, a ryzyko przebudowy uprawnień w istniejących bazach jest duże.

