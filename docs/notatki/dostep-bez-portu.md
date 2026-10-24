# Notatka: dostęp do panelu bez numeru portu

Pytanie: czy da się wchodzić do NetPulse bez wpisywania `IP-serwera:8080`? Odpowiedź: tak, a całą
konfigurację robi się na serwerze, w jednym pliku `/opt/netpulse/deploy/.env`.
(Notatka robocza, nie jest jeszcze częścią dokumentacji użytkownika.)

## 1. Port 80 → `http://IP-serwera`

Przeglądarki domyślnie używają portu 80, więc wtedy numeru nie trzeba wpisywać.

Sprawdź, czy port 80 jest wolny (pusty wynik = wolny):

```bash
sudo ss -ltn 'sport = :80'
```

Ustaw port i zastosuj zmianę:

```bash
sudo sed -i 's/^NETPULSE_PORT=.*/NETPULSE_PORT=80/' /opt/netpulse/deploy/.env
netpulse start
```

- Samo `netpulse restart` **nie wystarczy**, bo nie odtwarza kontenera z nowym portem. Robi to `netpulse start`.
- Dane, konto i urządzenia zostają. Stare zakładki z `:8080` przestaną działać.
- Powrót: ta sama komenda z `8080`.

## 2. Nazwa zamiast adresu IP

- **mDNS (z serwera):** `sudo apt install -y avahi-daemon`, potem `http://NAZWA-SERWERA.local`
  (nazwę pokaże `hostname`). Działa na Windows 10+, macOS, iOS; na Androidzie bywa różnie.
- **DNS w routerze (UniFi):** lokalny wpis, np. `netpulse.lan` → adres serwera. Robi się to w panelu
  routera, nie na serwerze. Dostępne na wszystkich urządzeniach w sieci.

Port 80 + nazwa = samo `http://netpulse.lan`.

## 3. HTTPS z ładnym adresem (reverse proxy)

Przed NetPulse stoi proxy (np. Caddy) na portach 80 i 443, a NetPulse zostaje na porcie wewnętrznym.

- Certyfikat: wewnętrzny urząd Caddy (trzeba go raz zaufać na każdym urządzeniu) albo Let's Encrypt,
  jeśli jest własna domena wskazująca na adres w LAN.
- W `.env` dopisz `NETPULSE_TRUSTED_ORIGINS=https://twoja-nazwa` i uruchom `netpulse start`.
  Bez tego ochrona CSRF odrzuci logowanie i zmiany przez proxy.
- Gdy proxy stoi na innym hoście niż NetPulse, ciasteczko sesji może nie dostać flagi `Secure`
  (uvicorn domyślnie ufa nagłówkom `X-Forwarded-*` tylko z 127.0.0.1). Trzeba to ustawić świadomie.
- Nie wystawiaj panelu do internetu bez VPN albo porządnie skonfigurowanego HTTPS.

## Do zrobienia (pomysły)

- Gotowy, opcjonalny profil Caddy w `deploy/` (HTTPS + nazwa bez portu) z instrukcją w `docs/`.
- Polecenie `netpulse config` (np. `netpulse config port 80`), żeby nie edytować `.env` ręcznie.
