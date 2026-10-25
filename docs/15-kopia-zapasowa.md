# Kopia zapasowa bazy (od 0.14.0)

Kopia zawiera całą bazę NetPulse: urządzenia, konta, ustawienia, reguły alertów, kanały powiadomień
i historię metryk. To `pg_dump` w formacie tekstowym, spakowany gzipem.

## Z panelu: Ustawienia → Kopia zapasowa

- **Utwórz kopię teraz**: nowa kopia na serwerze. Przy dużej historii metryk może to potrwać kilka minut.
- **Pobierz**: plik `.sql.gz` na komputer. Warto trzymać choć jedną kopię poza serwerem.
- **Wgraj kopię z komputera** (od 0.16.0): wybierasz pobrany wcześniej plik `.sql.gz`, serwer zapisuje go pod
  własną nazwą („wgrana z komputera”) i sprawdza, że to cały, nieucięty zrzut bazy NetPulse. Potem wystarczy
  kliknąć **Przywróć** przy tej kopii. Limit rozmiaru: 4 GB (zmiana: `NETPULSE_MAX_UPLOAD_MB` w `deploy/.env`).
- **Przywróć**: baza wraca do stanu z kopii. Kolejno:
  1. NetPulse robi kopię bezpieczeństwa obecnego stanu („przed przywróceniem”), więc da się to cofnąć;
  2. zatrzymuje API i kolektor (panel jest niedostępny przez około minutę i odświeży się sam);
  3. tworzy pustą bazę i wczytuje kopię (procedura TimescaleDB `pre_restore` / `post_restore`);
  4. uruchamia usługi. Kolektor sam migruje schemat, jeśli kopia pochodzi ze starszej wersji NetPulse;
  5. jeśli wczytanie się nie uda, wraca do kopii bezpieczeństwa.
- Po przywróceniu trzeba się zwykle zalogować ponownie, bo sesje logowania też wracają do stanu z kopii.
- **Usuń**: kasuje plik kopii z serwera.

Przywracanie i aktualizacja się wykluczają. Gdy trwa jedno, drugie dostaje komunikat „trwa…”.

## Z konsoli

```bash
sudo netpulse backup
```

`netpulse update` też robi kopię bazy przed zmianą kodu, tak samo jak aktualizacja z panelu. Jeśli kopia się
nie uda, aktualizacja nie startuje i nic się nie zmienia.

## Gdzie są kopie i ile ich zostaje

Katalog `backups` instalacji, domyślnie `/opt/netpulse/backups`, pliki z prawami 600.

| Nazwa | Skąd | Zostaje |
|-------|------|---------|
| `netpulse-RRRRMMDD-GGMMSS.sql.gz` | przed aktualizacją | 3 ostatnie |
| `netpulse-manual-RRRRMMDD-GGMMSS.sql.gz` | panel albo `netpulse backup` | 10 ostatnich |
| `netpulse-prerestore-RRRRMMDD-GGMMSS.sql.gz` | automatycznie przed przywróceniem | 3 ostatnie |
| `netpulse-upload-RRRRMMDD-GGMMSS.sql.gz` | wgrana z komputera przez panel | 5 ostatnich |

## Przeniesienie na nowy serwer

Zainstaluj NetPulse na nowym serwerze (`install.sh`), załóż konto w kreatorze, a potem w Ustawienia → Kopia
zapasowa **wgraj kopię z komputera** i ją **przywróć**. Po przywróceniu logujesz się kontem z kopii.

Bez panelu: skopiuj plik do `/opt/netpulse/backups/` (nazwa jak w tabeli wyżej, np.
`netpulse-manual-20261025-120000.sql.gz`, prawa 600) – pojawi się na liście kopii.

**Klucz szyfrowania (od 0.15.0).** Sekrety w bazie (community SNMP, klucze SNMPv3, klucz API UniFi, adresy
webhooków) są zaszyfrowane kluczem tej instalacji. Kopia bazy zawiera je zaszyfrowane, więc na nowym serwerze
potrzebny jest ten sam klucz. Odczytaj go na starym serwerze:

```bash
sudo docker exec netpulse-api-1 cat /var/lib/netpulse/secret.key
```

i na nowym serwerze wpisz w `deploy/.env` jako `NETPULSE_SECRET_KEY=…`, a potem `sudo netpulse start`
(odtwarza kontenery z nową konfiguracją; samo `restart` nie wczytuje zmian z `.env`).
Bez klucza reszta danych działa, ale sekrety trzeba wpisać ponownie (urządzenia, kontrolery, webhooki).

## Jak to działa w środku

Kopie wykonuje usługa `updater` (jedyny kontener z dostępem do Dockera): `updater/netpulse_updater/backups.py`.
API (`backend/netpulse/api/backups.py`, tylko administrator) przekazuje żądania z tokenem. Jedyny parametr
z żądania, który trafia do poleceń, to nazwa kopii, sprawdzana wyrażeniem regularnym. Stan przywracania jest
w `.update/restore.json`, więc panel pokaże wynik także po przeładowaniu.
