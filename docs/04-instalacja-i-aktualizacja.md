# Instalacja i aktualizacja NetPulse

## Instalacja (jedna komenda)

Na serwerze Ubuntu:

```bash
curl -fsSL https://raw.githubusercontent.com/arkadiuszbaglaj/NetPulse/main/install.sh | sudo bash
```

Skrypt:
1. instaluje Dockera (jeśli go nie ma),
2. pobiera NetPulse do `/opt/netpulse`,
3. tworzy `/opt/netpulse/deploy/.env` z losowym hasłem do bazy,
4. instaluje polecenie `netpulse`,
5. uruchamia usługi: baza (TimescaleDB), kolektor, API.

Pierwsza instalacja trwa kilka minut (pobieranie obrazów i budowanie).

## Dodanie urządzeń

Najwygodniej w panelu: **Ustawienia → Urządzenia → Dodaj urządzenie**. Formularz obsługuje SNMP v1,
v2c i v3, sprawdza połączenie i pokazuje, co wykryto (typ, model, liczba portów), a urządzenia można
też edytować, tymczasowo wyłączyć albo usunąć. Zapisane community i hasła SNMPv3 nigdy nie wracają do
przeglądarki: przy edycji puste pole oznacza „zostaw zapisane”.

To samo z terminala:

```bash
netpulse device add "UCG Ultra" 192.168.1.1 --community public
netpulse device add "USW Lite 8 PoE" 192.168.1.2 --community public
netpulse device add "U6+" 192.168.1.3 --community public
netpulse device list
```

Przed dodaniem NetPulse sprawdza połączenie SNMP i pokazuje, co wykrył.
Samo sprawdzenie, bez dodawania:

```bash
netpulse probe 192.168.1.2 --community public
```

## Sprawdzenie, że działa

- `netpulse status` – stan usług (db, collector, api)
- `netpulse device list` – status urządzeń i czas ostatniego odczytu
- `http://IP-serwera:PORT` – panel (Dashboard z kartami urządzeń)
- `http://IP-serwera:PORT/docs` – interaktywne API; np. `GET /api/devices/1/interfaces`
  pokazuje porty z bieżącym ruchem (`in_bps`, `out_bps` w bitach/s)

Metryki ruchu pojawiają się po drugim odczycie (ok. 1 minuty po dodaniu urządzenia),
bo przepływ liczony jest z różnicy liczników.

## Aktualizacja

Z panelu: **Ustawienia → Aktualizacja** (szczegóły, bezpieczeństwo i kopie bazy: [`07-aktualizacja-z-panelu.md`](07-aktualizacja-z-panelu.md)). Z terminala:

```bash
netpulse update
```

Pobiera najnowszą wersję z GitHuba, pokazuje listę zmian, przebudowuje i restartuje
usługi. Dane i konfiguracja zostają. Jeśli nie ma nic nowego – nic nie robi
(wymuszenie: `netpulse update --force`).

## Pozostałe polecenia

| Polecenie                 | Co robi                                 |
|---------------------------|-----------------------------------------|
| `netpulse status`         | stan kontenerów                         |
| `netpulse logs`           | logi wszystkich usług (Ctrl+C kończy)   |
| `netpulse logs collector` | logi tylko kolektora                    |
| `netpulse restart`        | restart usług                           |
| `netpulse device remove ID` | usunięcie urządzenia z historią       |
| `netpulse cleanup`        | zwolnienie miejsca: nieużywane obrazy i cache budowania (baza zostaje) |
| `netpulse reset`          | wyczyszczenie bazy (urządzenia i historia), konfiguracja zostaje |
| `netpulse user list`      | konta panelu                            |
| `netpulse user passwd NAZWA` | nowe hasło (np. zapomniane)          |
| `netpulse version`        | zainstalowana wersja                    |
| `netpulse uninstall`      | usunięcie NetPulse                      |

## Miejsce na dysku

Budowanie obrazów (panel w Node + backend w Pythonie) potrzebuje kilku GB wolnego miejsca. Dlatego
`install.sh` i `netpulse update` sprawdzają je **przed** zmianą czegokolwiek:

- poniżej 4 GB: automatycznie usuwają nieużywane dane Dockera (stary cache budowania i obrazy),
  a baza z historią metryk i konfiguracja nie są ruszane,
- poniżej 2 GB po sprzątaniu: zatrzymują się z komunikatem i podpowiedzią, **bez żadnej zmiany**
  (po zwolnieniu miejsca wystarczy ponowić `netpulse update`),
- po udanej aktualizacji usuwają cache budowania starszy niż 72 godziny (świeży zostaje, więc
  kolejna aktualizacja jest szybka).

Ręcznie: `netpulse cleanup`. Gdy dysk jest duży, ale system używa tylko jego części (domyślny układ
LVM w Ubuntu Server): `sudo vgs`, a jeśli `VFree` pokazuje wolne miejsce,
`sudo lvextend -r -l +100%FREE /dev/mapper/ubuntu--vg-ubuntu--lv`.

Jeśli budowanie nie powiodło się z innej przyczyny po pobraniu kodu, usługi działają dalej na
poprzedniej wersji, a po usunięciu przyczyny trzeba uruchomić `netpulse update --force`
(zwykły `update` powie, że masz już najnowszą wersję).

## Konfiguracja

Plik `/opt/netpulse/deploy/.env`:

| Zmienna                   | Domyślnie | Opis                              |
|---------------------------|-----------|-----------------------------------|
| `NETPULSE_PORT`           | 8000      | port API/panelu                   |
| `NETPULSE_POLL_INTERVAL`  | 30        | co ile sekund odpytywać urządzenia |
| `NETPULSE_RETENTION_DAYS` | 30        | ile dni trzymać metryki           |

Progi kontroli miejsca (zmienne środowiskowe polecenia, nie `.env`): `NETPULSE_MIN_FREE_MB` (domyślnie
2000), `NETPULSE_WARN_FREE_MB` (4000), `NETPULSE_KEEP_BUILD_CACHE_HOURS` (72), np.
`sudo NETPULSE_MIN_FREE_MB=1000 netpulse update`.

Cache budowania obrazów (od 0.28.1): po każdej aktualizacji zostaje cache z ostatnich 72 godzin, ale razem nie
więcej niż `NETPULSE_BUILD_CACHE_MAX` (domyślnie `2gb`; dla aktualizacji z panelu – w `.env`). Wcześniej przy wielu
aktualizacjach w krótkim czasie cache potrafił urosnąć do kilku GB. Ręczne sprzątanie: `sudo docker builder prune -af`
(baza i dane zostają, następna aktualizacja zbuduje się raz dłużej).

Po zmianie: `netpulse restart`.

Czasy w `netpulse device list` są pokazywane w strefie ze zmiennej `TZ` (domyślnie `Europe/Warsaw`).

## Baza ze starszej wersji

Jeśli na serwerze była wcześniej inna (testowa) wersja NetPulse, polecenia mogą zgłosić:
„Baza danych pochodzi ze starszej, niezgodnej wersji NetPulse”. Wtedy:

```bash
netpulse reset
```

Usuwa urządzenia i historię metryk, zostawia `.env`. Potem dodaj urządzenia ponownie.

## Logowanie

Od wersji 0.2 panel i API wymagają logowania. Zaraz po instalacji otwórz
`http://IP-serwera:PORT` – panel poprosi o założenie konta administratora (kreator, tylko raz).
Szczegóły: [`05-api-i-logowanie.md`](05-api-i-logowanie.md). Zapomniane hasło:
`netpulse user passwd admin`.

> Nie wystawiaj portu panelu bezpośrednio do internetu – do dostępu z zewnątrz użyj VPN
> albo reverse proxy z HTTPS.
