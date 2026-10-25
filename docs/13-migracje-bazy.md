# Migracje bazy (Alembic)

Od wersji 0.10.0 schemat bazy zmienia się przez migracje Alembic. Dzięki temu `netpulse update` (i aktualizacja
z panelu) potrafi dodać kolumnę do istniejącej tabeli bez `netpulse reset` i bez utraty historii.

## Jak to działa u użytkownika

Nic się nie zmienia: aktualizacja dalej jest jedną komendą albo jednym kliknięciem.

1. Kolektor przy starcie uruchamia `netpulse db init`.
2. `init_db` bierze blokadę w bazie (`pg_advisory_xact_lock`), żeby dwa procesy nie migrowały naraz.
3. Alembic wykonuje brakujące migracje (`alembic upgrade head`) w **jednej transakcji** z resztą
   przygotowania bazy. Gdy coś się nie uda, baza zostaje dokładnie taka, jak była.
4. Na koniec bezpiecznik: jeśli w tabelach dalej brakuje kolumn, kolektor kończy się czytelnym błędem
   (jak dotąd), zamiast sypać błędami SQL.

Aktualizacja z panelu i `netpulse update` z konsoli (od 0.14.0) robią przed zmianami kopię bazy (`pg_dump` do
katalogu `backups`, patrz `docs/15-kopia-zapasowa.md`).

Sprawdzenie wersji schematu na serwerze:

```bash
sudo netpulse db status
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
