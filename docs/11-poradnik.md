# NetPulse: kompletny poradnik

NetPulse to self-hosted panel do monitorowania sieci w homelabie. Zbiera w jednym miejscu ruch i stan portów
routera, switchy i access pointów, klientów sieci, zasilanie PoE, mapę połączeń i stan serwerów Linux.
Ten poradnik prowadzi od czystego serwera do działającego panelu i opisuje codzienną obsługę.

Wszystkie polecenia są do skopiowania. Przykładowe adresy (`192.168.1.x`) zamień na własne.

## Spis treści

1. [Wymagania](#1-wymagania)
2. [Instalacja](#2-instalacja)
3. [Pierwsze logowanie](#3-pierwsze-logowanie)
4. [Przygotowanie urządzeń: SNMP](#4-przygotowanie-urządzeń-snmp)
5. [Dodawanie urządzeń](#5-dodawanie-urządzeń)
6. [Kontroler UniFi: PoE, klienci, mapa sieci](#6-kontroler-unifi-poe-klienci-mapa-sieci)
7. [Serwery Linux](#7-serwery-linux)
8. [Panel: co gdzie jest](#8-panel-co-gdzie-jest)
9. [Aktualizacja](#9-aktualizacja)
10. [Konfiguracja](#10-konfiguracja)
11. [Adres bez numeru portu, nazwa i HTTPS](#11-adres-bez-numeru-portu-nazwa-i-https)
12. [Kopia i przywracanie bazy](#12-kopia-i-przywracanie-bazy)
13. [Wszystkie polecenia](#13-wszystkie-polecenia)
14. [Bezpieczeństwo](#14-bezpieczeństwo)
15. [Rozwiązywanie problemów](#15-rozwiązywanie-problemów)
16. [Odinstalowanie](#16-odinstalowanie)

---

## 1. Wymagania

- Serwer z **Ubuntu Server** (testowane na 24.04 LTS), dostęp przez SSH i konto z `sudo`.
- Serwer musi widzieć urządzenia w sieci (SNMP to UDP, port 161).
- Kilka GB wolnego miejsca na dysku: budowanie obrazów wymaga co najmniej 2 GB, zalecane 4 GB i więcej.
- Połączenie z internetem na czas instalacji i aktualizacji (pobieranie Dockera i kodu z GitHuba).

Docker instaluje skrypt instalacyjny sam, jeśli go brak.

## 2. Instalacja

Jedna komenda na serwerze:

```bash
curl -fsSL https://raw.githubusercontent.com/arkadiuszbaglaj/NetPulse/main/install.sh | sudo bash
```

Skrypt:

1. sprawdza wolne miejsce i w razie potrzeby sprząta nieużywane dane Dockera,
2. instaluje Dockera (jeśli go nie ma),
3. pobiera NetPulse do `/opt/netpulse`,
4. tworzy `/opt/netpulse/deploy/.env` z losowym hasłem do bazy,
5. instaluje polecenie `netpulse`,
6. uruchamia usługi: baza (PostgreSQL + TimescaleDB), kolektor, API z panelem i usługę aktualizacji.

Pierwsza instalacja trwa kilka minut (pobieranie obrazów i budowanie). Sprawdź, że wszystko działa:

```bash
netpulse status
netpulse version
```

Panel jest pod adresem `http://IP-SERWERA:8000` (port ze zmiennej `NETPULSE_PORT`, patrz [rozdział 10](#10-konfiguracja)).

## 3. Pierwsze logowanie

Po instalacji nie ma żadnego konta. Otwórz `http://IP-SERWERA:8000`, a panel pokaże kreator: podaj login i hasło
(co najmniej 10 znaków, panel pokazuje na żywo, czy hasło spełnia podpowiedzi). Kreator założy konto
administratora i od razu Cię zaloguje. Działa tylko raz.

> Do chwili założenia konta zrobić to może każdy w sieci lokalnej, więc załóż je od razu po instalacji.

Konta z terminala:

```bash
netpulse user list
netpulse user add NAZWA
netpulse user passwd admin
```

`passwd` ustawia nowe hasło (np. zapomniane) i wylogowuje wszystkie sesje tego konta.

## 4. Przygotowanie urządzeń: SNMP

NetPulse odpytuje urządzenia przez SNMP v1, v2c lub v3. Najpierw SNMP trzeba włączyć na urządzeniu.

### UniFi (router, switche, access pointy)

W aplikacji UniFi Network włącz SNMP. Nazwy menu zmieniają się między wersjami, zwykle jest to
**Settings → System → Advanced** albo **Settings → Control Plane → Integrations**, sekcja **SNMP Monitoring**.

1. Włącz **SNMPv1/v2c**.
2. Ustaw własną nazwę community (nie zostawiaj `public`), np. `netpulse-ro`.
3. Zapisz. Ustawienie trafia do adoptowanych urządzeń (switch, AP).

### Sprawdzenie SNMP z serwera (opcjonalnie)

```bash
sudo apt update && sudo apt install -y snmp
snmpwalk -v2c -c netpulse-ro 192.168.1.1 1.3.6.1.2.1.1
```

Odpowiedź z nazwą i opisem urządzenia oznacza, że SNMP działa. Brak odpowiedzi to zazwyczaj zła nazwa community,
wyłączone SNMP albo zapora.

## 5. Dodawanie urządzeń

### W panelu

**Ustawienia → Urządzenia → Dodaj urządzenie.** Podaj nazwę, adres IP, wersję SNMP i community (dla SNMP v3
nazwę użytkownika i klucze), a potem **Testuj połączenie**: NetPulse pokaże, co wykrył (typ, model, liczba portów).
Sterownik zostaw na „Automatyczny" (zalecany). Zapisane community i klucze nigdy nie wracają do przeglądarki;
przy edycji puste pole oznacza „zostaw zapisane".

### Z terminala

```bash
netpulse device add "UCG Ultra" 192.168.1.1 --community netpulse-ro
netpulse device add "USW Lite 8 PoE" 192.168.1.2 --community netpulse-ro
netpulse device add "U6+" 192.168.1.3 --community netpulse-ro
netpulse device list
```

Sam test, bez dodawania:

```bash
netpulse probe 192.168.1.2 --community netpulse-ro
```

SNMP v3 (uwierzytelnianie i szyfrowanie):

```bash
netpulse device add "Router" 192.168.1.1 --snmp-version 3 \
  --v3-user monitor --v3-auth-proto SHA --v3-auth-key 'KLUCZ-AUTH' \
  --v3-priv-proto AES --v3-priv-key 'KLUCZ-PRIV'
```

Usunięcie urządzenia razem z historią (ID z `netpulse device list`):

```bash
netpulse device remove 3
```

Pierwsze wykresy ruchu pojawiają się po drugim odczycie, czyli około minuty po dodaniu urządzenia
(przepływ jest liczony z różnicy liczników).

## 6. Kontroler UniFi: PoE, klienci, mapa sieci

SNMP nie podaje mocy PoE na portach, listy klientów (nazwa, sygnał, port) ani połączeń między urządzeniami.
Te dane NetPulse czyta z kontrolera UniFi Network przez klucz API (tylko odczyt).

1. W UniFi Network: **Settings → Control Plane → Integrations → Create API Key**. Nazwa dowolna, np. `netpulse`.
   Klucz widać tylko raz, więc skopiuj go od razu. Nie wklejaj go do czatów ani do repozytoriów.
2. W NetPulse: **Ustawienia → Kontrolery UniFi → Dodaj kontroler**. Podaj adres kontrolera (u Ciebie brama,
   np. `192.168.1.1`), klucz API i `site` (zwykle `default`). Kontrolery mają zwykle certyfikat samopodpisany,
   więc zostaw weryfikację certyfikatu wyłączoną. **Testuj połączenie** pokaże wersję UniFi Network i liczbę
   urządzeń oraz klientów.
3. Po jednym cyklu (ok. 30 s) działają: strona **Klienci**, widget **PoE switcha** oraz **Mapa sieci**.

Urządzenie z kontrolera łączone jest z urządzeniem w NetPulse po adresie IP, więc dodaj je też w Ustawienia → Urządzenia
(adres musi się zgadzać).

Uwaga: NetPulse używa też starszego, nieoficjalnego API kontrolera, bo tylko ono ma moc PoE i sygnał klientów.
Po dużej aktualizacji UniFi coś może się zmienić. Testy na zapisanych odpowiedziach wykrywają taką zmianę
w nowej wersji NetPulse.

## 7. Serwery Linux

Serwer Linux jest w NetPulse zwykłym urządzeniem i działa przez SNMP (`snmpd`). Pokazuje CPU, RAM, swap,
obciążenie, dyski, liczbę procesów, czas pracy i ruch na interfejsach (bez śmieci z Dockera).

Na monitorowanym serwerze:

```bash
sudo apt update && sudo apt install -y snmpd
```

Wpisz do `/etc/snmp/snmpd.conf` (zastąp zawartość). Podmień `192.168.1.10` na adres serwera z NetPulse,
a `netpulse-ro` na własne community:

```
agentaddress udp:161
rocommunity netpulse-ro 192.168.1.10
sysLocation  szafa
sysContact   admin
```

```bash
sudo systemctl restart snmpd && sudo systemctl enable snmpd
sudo ufw allow from 192.168.1.10 to any port 161 proto udp
```

(Ostatnie polecenie tylko, jeśli używasz zapory `ufw`.) Sprawdzenie z serwera NetPulse:

```bash
snmpwalk -v2c -c netpulse-ro 192.168.1.20 1.3.6.1.2.1.25.2.3.1.3
```

Potem dodaj serwer w **Ustawienia → Urządzenia** ze sterownikiem „Automatyczny" (rozpozna serwer sam) albo
„Serwer Linux (snmpd)". Szczegóły i rozwiązywanie problemów: [`docs/10-serwer-linux-snmp.md`](10-serwer-linux-snmp.md).

Czego SNMP nie da: kontenerów, usług systemd, SMART i temperatur (to zakres planowanego agenta).

## 8. Panel: co gdzie jest

| Sekcja | Co zawiera |
|--------|------------|
| **Dashboard** | Podsumowanie (urządzenia, ruch WAN, klienci WiFi), wykresy, karty urządzeń, PoE, stan serwera |
| **Klienci** | Lista klientów sieci: WiFi (sieć, pasmo, sygnał) i po kablu (switch i port), z wyszukiwarką |
| **Mapa sieci** | Schemat połączeń: Internet, brama, switche, access pointy, klienci przy portach |
| **Alerty** | Aktywne alerty i historia, potwierdzanie. Dzwonek w pasku górnym pokazuje licznik niepotwierdzonych aktywnych alertów |
| **Ustawienia** | Konto, Urządzenia, Kontrolery UniFi, Reguły alertów, Odświeżanie, System, Aktualizacja |

### Dashboard i personalizacja

**Edytuj pulpit** włącza tryb edycji: przeciągaj widgety, zmieniaj ich szerokość, edytuj i usuwaj, a potem **Zapisz**
(układ zapisuje się na koncie). **Przywróć domyślny** wraca do wyglądu początkowego. Dostępne widgety:
Wykres, Podsumowanie, Karty urządzeń, PoE switcha, Serwer.

Wykres ma własne ustawienia: źródło (ruch WAN, port, urządzenie, sieć WiFi, klienci WiFi, serwer NetPulse),
metryki i kolory, typ (linia, obszar, słupki), jednostkę (bity albo bajty), maksimum osi, zakres czasu, odświeżanie
i wysokość.

### Odświeżanie i tryb „Na żywo"

W pasku górnym wybierasz interwał odświeżania, a zakres czasu wykresów nad pulpitem. Przy wykresie ruchu WAN
jest przełącznik **Na żywo**: liczby i wykres odświeżają się co 1–2 sekundy przez WebSocket (bez zapisu do bazy,
a gdy nikt nie patrzy, router nie jest dodatkowo odpytywany). Po zerwaniu połączenia wykres wraca do zwykłego odświeżania.

### Alerty

**Ustawienia → Reguły alertów.** Domyślnie włączone są „Urządzenie nie odpowiada" i „Port przeszedł w stan down".
Można dodawać reguły z progami (np. CPU, RAM, ruch WAN) i czasem trwania, żeby krótkie skoki nie dawały alarmów.

### System

**Ustawienia → System** pokazuje stan usług NetPulse (API, baza, kolektor, kontrolery UniFi, usługa aktualizacji)
oraz stan serwera, na którym NetPulse działa: CPU, RAM, dysk, obciążenie, temperaturę i rozmiar bazy, z wykresami.

## 9. Aktualizacja

### Z panelu

**Ustawienia → Aktualizacja → Sprawdź aktualizacje**, potem **Aktualizuj do …** (tylko administrator). Aktualizacja
trwa kilka minut, panel jest wtedy chwilowo niedostępny. Przed zmianą robiona jest kopia bazy, a przy błędzie
następuje automatyczne wycofanie do poprzedniej wersji. Można też włączyć automatyczne sprawdzanie i plakietkę
w pasku górnym, gdy jest nowa wersja.

### Z terminala

```bash
netpulse update
```

Pobiera najnowszą wersję, pokazuje listę zmian, przebudowuje i restartuje usługi. Dane i konfiguracja zostają.
Wymuszenie, gdy po nieudanym budowaniu potrzebna jest ponowna próba:

```bash
netpulse update --force
```

Aktualizacja z panelu pojawiła się w wersji 0.6.0. Na starszej instalacji zaktualizuj raz z terminala.

### Miejsce na dysku

`install.sh` i `netpulse update` sprawdzają wolne miejsce przed zmianą czegokolwiek: poniżej 4 GB sprzątają
nieużywane dane Dockera, a poniżej 2 GB po sprzątaniu zatrzymują się bez żadnych zmian. Ręcznie:

```bash
netpulse cleanup
```

Gdy dysk jest duży, ale system używa tylko jego części (domyślny układ LVM w Ubuntu Server):

```bash
sudo vgs
sudo lvextend -r -l +100%FREE /dev/mapper/ubuntu--vg-ubuntu--lv
```

(drugie polecenie tylko, jeśli `VFree` w pierwszym pokazuje wolne miejsce).

## 10. Konfiguracja

Plik `/opt/netpulse/deploy/.env`. Po zmianie zastosuj ją poleceniem `netpulse start` (samo `netpulse restart`
nie odtwarza kontenerów z nowym portem).

| Zmienna | Domyślnie | Opis |
|---------|-----------|------|
| `NETPULSE_PORT` | 8000 | port panelu i API na serwerze |
| `NETPULSE_POLL_INTERVAL` | 30 | co ile sekund odpytywać urządzenia |
| `NETPULSE_RETENTION_DAYS` | 30 | ile dni trzymać szczegółowe metryki |
| `NETPULSE_LOG_LEVEL` | INFO | poziom logów |
| `TZ` | Europe/Warsaw | strefa czasowa |
| `NETPULSE_UPDATER` | on | `off` wyłącza aktualizację z panelu |
| `NETPULSE_TRUSTED_ORIGINS` | puste | dodatkowe adresy panelu (za reverse proxy), oddzielone przecinkami |
| `NETPULSE_SESSION_DAYS` | 30 | ważność sesji logowania |

Przykład edycji:

```bash
sudo nano /opt/netpulse/deploy/.env
netpulse start
```

Krótszy interwał odpytywania daje gęstsze wykresy, ale baza rośnie proporcjonalnie (10 s to około 3 razy więcej
wierszy niż 30 s).

## 11. Adres bez numeru portu, nazwa i HTTPS

### Port 80: `http://IP-SERWERA`

Sprawdź, czy port 80 jest wolny (pusty wynik oznacza wolny):

```bash
sudo ss -ltn 'sport = :80'
```

Ustaw port i zastosuj zmianę:

```bash
sudo sed -i 's/^NETPULSE_PORT=.*/NETPULSE_PORT=80/' /opt/netpulse/deploy/.env
netpulse start
```

Dane, konto i urządzenia zostają, a stare zakładki z `:8000` przestaną działać. Powrót: ta sama komenda z `8000`.

### Nazwa zamiast adresu IP

- **mDNS (z serwera):** `sudo apt install -y avahi-daemon`, potem `http://NAZWA-SERWERA.local` (nazwę pokaże `hostname`).
  Działa na Windows 10+, macOS i iOS; na Androidzie bywa różnie.
- **DNS w routerze (UniFi):** lokalny wpis, np. `netpulse.lan` wskazujący na serwer. Robi się to w panelu routera.

### HTTPS (reverse proxy)

Przed NetPulse można postawić proxy (np. Caddy) na portach 80 i 443. Wtedy w `.env` dopisz adres, pod którym panel
jest dostępny, i zastosuj zmianę, bo inaczej ochrona CSRF odrzuci logowanie:

```bash
echo 'NETPULSE_TRUSTED_ORIGINS=https://netpulse.lan' | sudo tee -a /opt/netpulse/deploy/.env
netpulse start
```

Nie wystawiaj panelu bezpośrednio do internetu: dostęp z zewnątrz tylko przez VPN albo porządnie skonfigurowane HTTPS.

## 12. Kopia i przywracanie bazy

Aktualizacja z panelu zapisuje kopię bazy w `/opt/netpulse/backups/netpulse-RRRRMMDD-GGMMSS.sql.gz` (zostają 3 ostatnie,
prawa tylko dla roota). Ręczna kopia:

```bash
cd /opt/netpulse
sudo docker compose -f deploy/docker-compose.yml --env-file deploy/.env exec -T db pg_dump -U netpulse netpulse | gzip | sudo tee backups/reczna-$(date +%Y%m%d-%H%M%S).sql.gz > /dev/null
```

Przywracanie (potrzebne tylko, gdy trzeba wrócić do stanu sprzed zmiany). Podmień nazwę pliku:

```bash
cd /opt/netpulse
DC="sudo docker compose -f deploy/docker-compose.yml --env-file deploy/.env"
$DC stop api collector
$DC exec -T db psql -U netpulse -d postgres -c "DROP DATABASE netpulse" -c "CREATE DATABASE netpulse"
$DC exec -T db psql -U netpulse -d netpulse -c "CREATE EXTENSION IF NOT EXISTS timescaledb" -c "SELECT timescaledb_pre_restore()"
sudo zcat backups/netpulse-RRRRMMDD-GGMMSS.sql.gz | $DC exec -T db psql -U netpulse -d netpulse -q
$DC exec -T db psql -U netpulse -d netpulse -c "SELECT timescaledb_post_restore()"
$DC start api collector
```

## 13. Wszystkie polecenia

Polecenia `netpulse` uruchamiaj na serwerze (większość wymaga `sudo`, a gdy go brakuje, skrypt sam o tym powie).

| Polecenie | Co robi |
|-----------|---------|
| `netpulse status` | stan usług (kontenerów) |
| `netpulse logs` | logi wszystkich usług (Ctrl+C kończy) |
| `netpulse logs collector` | logi tylko kolektora (analogicznie `api`, `db`, `updater`) |
| `netpulse start` | uruchom usługi (zastosuje też zmiany z `.env`) |
| `netpulse stop` | zatrzymaj usługi |
| `netpulse restart` | restart usług |
| `netpulse update` | aktualizacja do najnowszej wersji (`--force` wymusza) |
| `netpulse version` | zainstalowana wersja |
| `netpulse cleanup` | zwolnij miejsce: nieużywane obrazy i cache budowania (baza zostaje) |
| `netpulse reset` | wyczyść bazę (urządzenia i historia), konfiguracja zostaje |
| `netpulse uninstall` | usuń NetPulse (pyta o usunięcie danych) |
| `netpulse device add NAZWA ADRES [opcje]` | dodaj urządzenie (opcje: `--community`, `--snmp-version`, `--port`, `--driver`, `--v3-*`, `--no-probe`) |
| `netpulse device list` | lista urządzeń ze statusem i czasem ostatniego odczytu |
| `netpulse device remove ID` | usuń urządzenie razem z historią |
| `netpulse probe ADRES [--community C] [--all]` | test SNMP bez zapisu (`--all` pokazuje też ukryte interfejsy) |
| `netpulse user list` | konta panelu |
| `netpulse user add NAZWA` | dodaj konto administratora |
| `netpulse user passwd NAZWA` | nowe hasło |

Interaktywna dokumentacja API (z możliwością wywołań po zalogowaniu): `http://IP-SERWERA:8000/docs`.

## 14. Bezpieczeństwo

- Panel i API wymagają logowania. Hasła są w bazie jako skrót Argon2, sesja w ciasteczku `HttpOnly`, ważna 30 dni od ostatniej
  aktywności. Po 10 nieudanych logowaniach z jednego adresu następuje 15 minut blokady.
- Zmiany (POST, PATCH, DELETE) przyjmowane są tylko z tej samej strony (ochrona CSRF).
- Community SNMP, klucze SNMP v3 i klucze API kontrolerów nigdy nie wracają do przeglądarki.
- Aktualizacja z panelu działa w osobnym kontenerze `updater`, jedynym z dostępem do Dockera. API rozmawia z nim przez sieć
  wewnętrzną z losowym tokenem, a zlecić aktualizację może tylko administrator. Wyłączenie: `NETPULSE_UPDATER=off` w `.env`.
- Używaj własnego community SNMP zamiast `public` i ograniczaj odczyt do adresu serwera NetPulse (patrz [rozdział 7](#7-serwery-linux)).
- Nie wystawiaj portu panelu do internetu bez VPN albo HTTPS.

## 15. Rozwiązywanie problemów

| Objaw | Co sprawdzić |
|-------|--------------|
| Panel się nie otwiera | `netpulse status`, `netpulse logs api`; port w `.env` i zapora serwera |
| „Brak odpowiedzi SNMP" przy dodawaniu | SNMP włączone na urządzeniu, nazwa community, adres, zapora (UDP 161): `snmpwalk -v2c -c COMMUNITY ADRES 1.3.6.1.2.1.1` |
| Brak wykresów po dodaniu urządzenia | poczekaj 1–2 minuty (potrzebne dwa odczyty); `netpulse device list` pokazuje status |
| Urządzenie „nie odpowiada" | `netpulse logs collector`; ten sam test `snmpwalk` z serwera |
| „Baza danych pochodzi ze starszej, niezgodnej wersji" | `netpulse reset` (usuwa urządzenia i historię), potem dodaj urządzenia ponownie |
| Brak PoE, klientów albo mapy sieci | dodany kontroler UniFi (rozdział 6), poprawny klucz API i `site`; adres urządzenia w NetPulse zgodny z kontrolerem |
| Za mało miejsca przy aktualizacji | `netpulse cleanup`, potem `netpulse update`; ewentualnie powiększ wolumen LVM (rozdział 9) |
| Aktualizacja nieudana po pobraniu kodu | usuń przyczynę (`netpulse logs`), potem `netpulse update --force` |
| Po zmianie `.env` nic się nie zmieniło | użyj `netpulse start` (samo `restart` nie odtwarza kontenerów) |
| Za reverse proxy nie da się zalogować | dopisz adres w `NETPULSE_TRUSTED_ORIGINS` i `netpulse start` |
| Zapomniane hasło | `netpulse user passwd admin` |
| Serwer Linux bez dysków lub rozpoznany jako ogólne urządzenie | [`docs/10-serwer-linux-snmp.md`](10-serwer-linux-snmp.md) |

## 16. Odinstalowanie

```bash
netpulse uninstall
```

Polecenie zapyta, czy usunąć NetPulse z serwera i czy usunąć też bazę z historią metryk. Odpowiedź „nie" na drugie pytanie
zostawia dane do ewentualnej ponownej instalacji.
