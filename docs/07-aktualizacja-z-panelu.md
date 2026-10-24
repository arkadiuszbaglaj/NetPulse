# Aktualizacja z panelu

**Ustawienia → Aktualizacja** pozwala sprawdzić, czy jest nowa wersja NetPulse, zobaczyć listę zmian
i zainstalować ją jednym kliknięciem. To samo robi polecenie `netpulse update` w terminalu –
oba sposoby działają równolegle i nie wchodzą sobie w drogę.

## Jak z tego korzystać

1. Wejdź w **Ustawienia → Aktualizacja** i kliknij **Sprawdź aktualizacje**.
2. Jeśli jest nowa wersja, zobaczysz jej numer i listę zmian (po jednej linii na zmianę).
3. Kliknij **Aktualizuj do …** i potwierdź. Aktualizacja trwa kilka minut. W tym czasie panel
   jest chwilowo niedostępny i pomiary są wstrzymane. Strona pokazuje postęp po fazach
   (przygotowanie, kopia bazy, pobranie, budowanie, uruchomienie, sprawdzenie) i dziennik pod
   przyciskiem **Szczegóły**.
4. Po sukcesie strona sama załaduje się od nowa, żeby użyć nowej wersji panelu.

Aktualizację może zlecić wyłącznie **administrator**; pozostali użytkownicy widzą tylko stan.

## Co się dzieje po kliknięciu

| Faza | Co robi | Gdy się nie uda |
|------|---------|-----------------|
| Przygotowanie | sprawdza wolne miejsce (minimum 2 GB, w razie potrzeby sprząta nieużywane dane Dockera) | zatrzymuje się, nic nie zmieniając |
| Kopia bazy | zapisuje `pg_dump` do `backups/netpulse-RRRRMMDD-GGMMSS.sql.gz` (prawa 0600, tylko root; zostają 3 ostatnie) | zatrzymuje się, nic nie zmieniając |
| Pobieranie | `git fetch` i przesunięcie kodu do najnowszej wersji, dopisanie nowych zmiennych do `.env` | zatrzymuje się, kod bez zmian |
| Budowanie | buduje nowe obrazy | kod wraca do poprzedniej wersji, usługi działają dalej na starej |
| Uruchamianie | uruchamia nowe usługi | **wycofanie** do poprzedniej wersji |
| Sprawdzanie | czeka do 150 s, aż API odpowie | **wycofanie** do poprzedniej wersji |

Po udanej aktualizacji usuwany jest cache budowania starszy niż 72 godziny.

**Wycofanie** to powrót kodu do poprzedniego commita i ponowne uruchomienie usług. Jeśli i to się nie uda,
panel pokaże to wprost i wskaże kopię bazy; ratunek: `netpulse logs`, a dane są w kopii.
Stan i dziennik zadania są zapisywane w plikach (`.update/`), więc przetrwają restart API w trakcie aktualizacji.

## Przywracanie kopii bazy

Kopia nie jest potrzebna przy zwykłej aktualizacji, tylko gdy trzeba wrócić do stanu sprzed niej.
Procedura jest sprawdzana w testach (CI odtwarza kopię do osobnej bazy). Na serwerze:

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

(`DROP DATABASE` zadziała, gdy API i kolektor są zatrzymane. Jeśli baza jest używana, zatrzymaj też inne połączenia.)

## Bezpieczeństwo

Aktualizacja wymaga dostępu do Dockera, a on jest równoważny uprawnieniom roota na serwerze.
Dlatego jest zamknięty w osobnym kontenerze `updater`:

- **API nie ma dostępu do Dockera.** Rozmawia z `updater` przez sieć wewnętrzną Dockera (port 8080 nie jest
  opublikowany na serwerze), z długim losowym tokenem. Token powstaje sam przy pierwszym starcie usługi
  i leży we wspólnym wolumenie Dockera (`updater-secret`), do którego dostęp mają tylko te dwa kontenery:
  nie ma go w `.env` ani w repozytorium i każda instalacja ma inny.
- `updater` zna tylko trzy akcje: status, sprawdzenie i aktualizacja. Żadna wartość z żądania nie trafia do poleceń.
- Zlecić aktualizację może tylko administrator panelu. Token nigdy nie trafia do przeglądarki.
- Samo zadanie aktualizacji działa w osobnym, jednorazowym kontenerze, więc wymiana usługi `updater`
  w trakcie aktualizacji go nie przerywa.
- Kod pochodzi wyłącznie ze **źródła aktualizacji**: adresu `origin` repozytorium w `/opt/netpulse`
  (domyślnie GitHub). Inne źródło ustawisz w `.env`: `NETPULSE_UPDATE_REPO` (adres repozytorium git)
  i `NETPULSE_UPDATE_BRANCH`. Źródło ma pełną władzę nad tym, co zostanie zbudowane i uruchomione,
  więc wskazuj tylko repozytoria, którym ufasz.

**Wyłączenie aktualizacji z panelu:** dopisz w `deploy/.env` linię `NETPULSE_UPDATER=off` i uruchom
`netpulse restart`. Usługa nie tworzy wtedy tokenu i odrzuca wszystkie żądania, a panel pokazuje, że
aktualizacja z panelu jest wyłączona, i podpowiada `netpulse update`. Całkowite usunięcie kontenera:
usuń usługę `updater` z `deploy/docker-compose.yml` i uruchom `netpulse update --force`.

**Własny katalog instalacji:** usługa musi widzieć katalog instalacji pod tą samą ścieżką co serwer
(docker compose przekazuje demonowi ścieżki hosta). Ścieżkę trzyma `NETPULSE_DIR` w `deploy/.env`
(instalator ustawia ją sam; domyślnie `/opt/netpulse`). Gdy wskazuje zły katalog, panel pokazuje
komunikat zamiast uruchamiać aktualizację.

## Pierwsze włączenie na istniejącej instalacji

Usługa `updater` pojawia się razem z wersją 0.6.0. Na instalacji starszej niż 0.6.0 trzeba raz
zaktualizować z terminala:

```bash
netpulse update
```

Polecenie dopisze do `.env` katalog instalacji (`NETPULSE_DIR`), zbuduje i uruchomi `updater`, który
sam utworzy token. Dalej wystarczy panel. Jeśli instalowałeś NetPulse w innym katalogu niż `/opt/netpulse`
i `netpulse update` uruchamiałeś wcześniej starszą wersją skryptu, sprawdź, czy `NETPULSE_DIR` w
`deploy/.env` wskazuje właściwy katalog.

## Ograniczenia i plany

- Aktualizacja **buduje obrazy na serwerze** (jak `netpulse update`), więc potrzebuje kilku GB wolnego miejsca
  i kilku minut. Gotowe obrazy w rejestrze (GHCR) skrócą to do pobrania i są w planie.
- Lista zmian to tytuły commitów. Opisy wydań z numerami wersji dojdą razem z wydaniami.
- Źródło aktualizacji to repozytorium git. Format źródła dla własnego serwera (chmura, subskrypcje)
  zostanie ustalony, gdy ten serwer powstanie.
