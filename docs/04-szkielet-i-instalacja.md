# Krok 2 – Szkielet projektu i instalacja

## Co powstało

```
NetPulse/
├── install.sh                 # instalacja jedną komendą
├── backend/                   # Python 3.13, FastAPI, SQLAlchemy 2 async
│   ├── app/
│   │   ├── config.py          # ustawienia ze zmiennych środowiskowych
│   │   ├── db.py              # połączenie z PostgreSQL (asyncpg)
│   │   ├── models.py          # model danych
│   │   └── main.py            # API – na razie tylko /api/health
│   ├── migrations/            # Alembic – schemat bazy, hypertables, retencja
│   ├── tests/
│   ├── Dockerfile
│   ├── pyproject.toml, uv.lock
└── deploy/
    ├── docker-compose.yml     # db (TimescaleDB) + backend
    └── .env.example           # wzór konfiguracji (hasła generuje install.sh)
```

### Kontenery

| Usługa    | Obraz                               | Port                        |
|-----------|-------------------------------------|-----------------------------|
| `db`      | `timescale/timescaledb:2.31.0-pg17` | brak (tylko sieć wewnętrzna) |
| `backend` | budowany z `backend/Dockerfile`     | `8080` na serwerze          |

Backend przy starcie sam wykonuje migracje bazy (`alembic upgrade head`).
Kolektor SNMP dojdzie w kroku 3, panel (frontend) w kroku 5.

### Model danych

| Tabela              | Typ        | Zawartość |
|---------------------|------------|-----------|
| `devices`           | zwykła     | urządzenia + dostęp SNMP: v1/v2c (community) **i v3** (użytkownik, auth MD5/SHA…SHA512, priv DES/3DES/AES128–256, context) |
| `interfaces`        | zwykła     | porty z IF-MIB: ifIndex, ifName, ifDescr, ifAlias, prędkość, status, rola (wan/lan/uplink/radio…), ukrycie |
| `interface_metrics` | hypertable | co 30 s na port: przepływ in/out (b/s), błędy, dropy, status |
| `device_metrics`    | hypertable | co 30 s na urządzenie: dostępność, czas odpowiedzi, uptime, load, RAM |

Metryki: **kompresja po 7 dniach, usuwanie po 90 dniach** (polityki TimescaleDB,
działają automatycznie).

## Instalacja na serwerze

> Skrypt pobiera kod z gałęzi `main` publicznego repozytorium. Dopóki zmiany z kroku 2
> nie są zmergowane do `main`, użyj wariantu „przed merge” poniżej.

**Docelowo (po merge do `main`):**

```bash
curl -fsSL https://raw.githubusercontent.com/arkadiuszbaglaj/NetPulse/main/install.sh | sudo bash
```

**Przed merge (test z gałęzi roboczej):**

```bash
B=claude/fervent-mayer-8v75ot
curl -fsSL https://raw.githubusercontent.com/arkadiuszbaglaj/NetPulse/$B/install.sh \
  | sudo NETPULSE_BRANCH=$B bash
```

Skrypt:

1. sprawdza, czy to Ubuntu (lub Debian),
2. instaluje Dockera z oficjalnego repozytorium, jeśli go nie ma,
3. klonuje projekt do `/opt/netpulse`,
4. tworzy `/opt/netpulse/deploy/.env` z losowymi hasłami (prawa `600`),
5. buduje i uruchamia kontenery, czeka na odpowiedź API.

Ponowne uruchomienie tej samej komendy = **aktualizacja**: pobiera nowy kod,
przebudowuje kontenery, a `.env` i dane w bazie zostają.

## Jak sprawdzić, że działa

```bash
# 1. Stan aplikacji – oczekiwany wynik: "status":"ok", "timescaledb":"2.31.0"
curl http://localhost:8080/api/health

# 2. Kontenery – oba "Up", db "(healthy)"
cd /opt/netpulse
sudo docker compose -f deploy/docker-compose.yml ps

# 3. Tabele i hypertables w bazie
sudo docker compose -f deploy/docker-compose.yml exec db \
  psql -U netpulse -d netpulse -c '\dt' \
  -c 'SELECT hypertable_name FROM timescaledb_information.hypertables'
```

Z komputera w sieci domowej: `http://<IP-serwera>:8080/docs` – automatyczna
dokumentacja API (Swagger).

## Przydatne komendy

```bash
cd /opt/netpulse
sudo docker compose -f deploy/docker-compose.yml logs -f backend   # logi na żywo
sudo docker compose -f deploy/docker-compose.yml restart backend   # restart
sudo docker compose -f deploy/docker-compose.yml down              # zatrzymanie (dane zostają)
```

Dane bazy leżą w wolumenie Dockera `netpulse_db-data`. `down -v` **usuwa je bezpowrotnie**.

## Praca nad backendem lokalnie (dla dewelopera)

```bash
cd backend
uv sync              # instaluje zależności do .venv
uv run pytest        # testy
uv run ruff check .  # lint
```
