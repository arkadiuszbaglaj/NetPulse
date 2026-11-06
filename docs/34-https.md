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

## Kod

`deploy/proxy/` (Dockerfile, `nginx.conf`, `proxy-common.conf`, `tls.sh`), `backend/netpulse/tls.py`,
`backend/netpulse/api/tls.py`, panel: `frontend/src/components/HttpsCard.tsx`. Testy: `tests/test_tls.py`,
`tests/test_scripts.py` (adresy z instalatora), krok „HTTPS przez proxy” w CI.

## Jak sprawdzić

1. `netpulse update`, potem `netpulse status` – jest usługa `proxy`.
2. Otwórz `https://<adres serwera>:8443` – przeglądarka ostrzeże (CA jeszcze nie jest zaufane), przejdź dalej.
3. Ustawienia → System → HTTPS → „Pobierz certyfikat CA”, zaimportuj go według instrukcji i otwórz stronę ponownie –
   kłódka bez ostrzeżeń.
