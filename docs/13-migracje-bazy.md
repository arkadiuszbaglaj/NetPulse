# Migracje bazy (Alembic)

Od wersji 0.10.0 schemat bazy zmienia się przez migracje Alembic. Dzięki temu `uplinkview update` (i aktualizacja
z panelu) potrafi dodać kolumnę do istniejącej tabeli bez `uplinkview reset` i bez utraty historii.

## Jak to działa u użytkownika

Nic się nie zmienia: aktualizacja dalej jest jedną komendą albo jednym kliknięciem.

1. Kolektor przy starcie uruchamia `uplinkview db init`.
2. `init_db` bierze blokadę w bazie (`pg_advisory_xact_lock`), żeby dwa procesy nie migrowały naraz.
3. Alembic wykonuje brakujące migracje (`alembic upgrade head`) w **jednej transakcji** z resztą
   przygotowania bazy. Gdy coś się nie uda, baza zostaje dokładnie taka, jak była.
4. Na koniec bezpiecznik: jeśli w tabelach dalej brakuje kolumn, kolektor kończy się czytelnym błędem
   (jak dotąd), zamiast sypać błędami SQL.

Aktualizacja z panelu i `uplinkview update` z konsoli (od 0.14.0) robią przed zmianami kopię bazy (`pg_dump` do
katalogu `backups`, patrz `docs/15-kopia-zapasowa.md`).

Sprawdzenie wersji schematu na serwerze:

```bash
sudo uplinkview db status
```

## Bazy sprzed migracji (0.9.0 i starsze)

Migracja bazowa `0001` to schemat z wersji 0.9.0. Tworzy tylko te tabele, których brakuje, więc:

- **nowa instalacja**: powstają wszystkie tabele;
- **instalacja z 0.9.0**: nic nie jest tworzone, baza dostaje tylko wpis wersji `0001`, dane zostają;
- **starsza instalacja** (brak nowszych tabel): brakujące tabele zostają dołożone, reszta zostaje.

## Jak dodać migrację (dla programisty)

1. Zmień model w `backend/netpulse/db/models.py`.
2. Wygeneruj migrację na bazie z aktualnym schematem (w katalogu `backend/`):

   ```bash
   NETPULSE_DATABASE_URL=postgresql+asyncpg://netpulse:netpulse@localhost:5432/netpulse alembic revision --autogenerate --rev-id 0002 -m "opis zmiany"
   ```

3. Przejrzyj plik w `netpulse/db/migrations/versions/`. Autogenerate nie wszystko zgadnie (np. zmiana nazwy
   kolumny wygląda jak usunięcie i dodanie – wtedy ręcznie `op.alter_column`).
4. Nowa kolumna `NOT NULL` w tabeli z danymi potrzebuje wartości dla istniejących wierszy:
   `server_default=...` w `op.add_column` (albo kolumna najpierw `nullable=True`, potem `UPDATE`, potem `NOT NULL`).
5. Kolejne numery: `0002`, `0003`, … (`--rev-id`), żeby kolejność była widać w nazwach plików.

Test `tests/test_migrations.py::test_fresh_db_matches_models` porównuje schemat po migracjach z modelami.
Gdy zmienisz model i zapomnisz o migracji, CI to wyłapie. `test_single_head` pilnuje, żeby migracje nie
rozgałęziły się (dwie migracje z tym samym poprzednikiem).

Hypertables i retencję zakłada dalej `init_db` po migracjach (lista `HYPERTABLES` w `models.py`), więc nowa
tabela metryk to: model, migracja i dopisanie nazwy do `HYPERTABLES`.

Cofanie migracji (`downgrade`) nie jest używane przy aktualizacjach. Do cofnięcia wersji służy kopia bazy
sprzed aktualizacji (Ustawienia → Kopia zapasowa → Przywróć).

## Indeksy tabel metryk (0017, wersja 0.65.4)

Klucz główny hypertables zaczyna się od czasu (`time`, obiekt), więc zapytanie o jeden port, urządzenie czy sieć WiFi
w oknie czasu czytało wiersze wszystkich obiektów z tego okna. Migracja `0017` dokłada indeksy (obiekt, `time`) na
`interface_metrics`, `device_metrics`, `wifi_metrics`, `disk_metrics`, `server_metrics` i `poe_port_metrics`
(pozostałe tabele metryk miały je od początku). Przy pierwszym starcie po aktualizacji zakładanie indeksów na
30 dniach danych może potrwać chwilę – kolektor zaczyna odpytywać dopiero po nim.

**Nowa tabela metryk (hypertable) = od razu indeks (obiekt, `time`)** w `__table_args__` modelu i w migracji.

## Kompresja metryk (wersja 0.67.0)

Od 0.67.0 TimescaleDB kompresuje chunki tabel metryk starsze niż 7 dni (`NETPULSE_COMPRESS_AFTER_DAYS`, `0` wyłącza).
Zakłada to `init_db` przy starcie kolektora (`netpulse/compression.py`), poza Alembikiem – tak jak hypertables
i agregaty godzinowe. Po aktualizacji istniejąca baza kompresuje starsze dane sama, w tle, w ciągu kilkunastu minut;
nic nie trzeba uruchamiać ręcznie.

- **Co się zmienia dla użytkownika:** baza zajmuje wyraźnie mniej miejsca (metryki kompresują się zwykle kilka–kilkanaście
  razy), a wykresy 30 dni, raport miesięczny i dostępność czytają mniej danych z dysku. Wykresy do 7 dni czytają
  dane nieskompresowane – bez zmian.
- **Podział na segmenty** (`SEGMENT_BY`): wiersze jednego obiektu (portu, urządzenia, sprawdzenia) leżą razem – te same
  kolumny co indeks (obiekt, `time`). **Nowa hypertable = wpis w `SEGMENT_BY`** (pilnuje `test_compression.py`).
- **Zapis i usuwanie działają dalej:** spóźniona próbka trafia do skompresowanego chunku, usunięcie urządzenia usuwa
  też jego skompresowane metryki (`test_compression_db.py`).
- **Migracje tabel metryk:** do skompresowanej hypertable można dodać kolumnę (bez wartości domyślnej albo ze stałą).
  Zmiana typu kolumny albo nowe ograniczenie wymagają wcześniejszej dekompresji chunków
  (`SELECT decompress_chunk(c, true) FROM show_chunks('tabela') c`) w tej samej migracji.
- **Sprawdzenie na serwerze** (z katalogu `deploy/` instalacji) – ile chunków każdej tabeli jest już skompresowanych:
  `docker compose exec db psql -U netpulse -d netpulse -c "SELECT hypertable_name, count(*) FILTER (WHERE is_compressed) AS skompresowane, count(*) AS wszystkie FROM timescaledb_information.chunks GROUP BY 1 ORDER BY 1"`
- Błąd kompresji jednej tabeli nie zatrzymuje startu – tabela zostaje nieskompresowana, w logu kolektora jest wpis
  „Kompresja tabeli …”.

