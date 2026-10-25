# Agent NetPulse dla serwerów Linux (etap 10B)

SNMP (`docs/10-serwer-linux-snmp.md`) daje CPU, RAM, obciążenie i dyski. Agent dokłada to, czego SNMP nie poda:
CPU na rdzeń, przepływ dysków i sieci, temperatury, stan usług systemd, kontenery Docker i SMART dysków.

## Jak to działa

- Agent to jeden plik Pythona (`/opt/netpulse-agent/netpulse-agent.py`, tylko biblioteka standardowa, Python 3.8+)
  uruchomiony jako usługa systemd `netpulse-agent`.
- Co interwał kolektora (domyślnie 30 s) wysyła raport do NetPulse: `POST /api/agent/v1/report` z tokenem
  w nagłówku `Authorization: Bearer npa_…`. To **push**: działa za NAT-em i nie wymaga otwierania portów na serwerze.
- Token tworzy panel (Ustawienia → Agenci). W bazie jest tylko jego skrót SHA-256, w panelu ostatnie 4 znaki.
- Serwer z agentem jest zwykłym urządzeniem (`driver = "agent"`, rodzaj „Serwer”): ta sama karta na pulpicie,
  te same alerty (urządzenie nie odpowiada, CPU, RAM, dysk). Kolektor go nie odpytuje przez SNMP. Jeśli raporty
  przestaną przychodzić na dłużej niż 3 interwały (co najmniej 90 s), serwer dostaje stan „niedostępny”.

## Instalacja (krok po kroku)

1. W panelu: **Ustawienia → Agenci serwerów → Dodaj serwer z agentem**, wpisz nazwę (np. „NAS”).
2. Panel pokaże polecenie z tokenem. Wklej je w terminalu monitorowanego serwera:

   ```bash
   curl -fsSL http://ADRES-NETPULSE:8000/agent/install.sh | sudo bash -s -- --url http://ADRES-NETPULSE:8000 --token npa_...
   ```

3. Instalator pobiera agenta z NetPulse, zapisuje konfigurację `/etc/netpulse-agent.conf` (prawa 600), wysyła
   raport testowy i uruchamia usługę. W ciągu minuty serwer pojawi się na pulpicie.

Sprawdzenie na serwerze:

```bash
systemctl status netpulse-agent
```

```bash
sudo journalctl -u netpulse-agent -n 50
```

Podgląd tego, co agent wysyła (bez wysyłania):

```bash
sudo python3 /opt/netpulse-agent/netpulse-agent.py --print
```

## Konfiguracja (`/etc/netpulse-agent.conf`)

| Klucz | Znaczenie |
|-------|-----------|
| `NETPULSE_URL` | adres panelu NetPulse |
| `NETPULSE_TOKEN` | token agenta |
| `SERVICES` | usługi systemd obserwowane zawsze, np. `nginx,ssh,smbd`. Usługi w stanie `failed` są raportowane i bez tego |
| `DOCKER` | `auto` (domyślnie: jeśli jest `/var/run/docker.sock`) albo `off` |
| `SMART` | `auto` (domyślnie: jeśli jest `smartctl`) albo `off`. SMART odczytywany co 30 min, śpiące dyski nie są budzone |
| `VERIFY_TLS` | `1` (domyślnie) albo `0` dla HTTPS z certyfikatem samopodpisanym |

Po zmianie: `sudo systemctl restart netpulse-agent`.

## Aktualizacja, nowy token, usunięcie

- **Aktualizacja agenta** po aktualizacji NetPulse: to samo polecenie instalacji, można bez `--token`
  (adres i token zostają z konfiguracji). Panel pokazuje wersję agenta przy serwerze.
- **Nowy token** (wyciek, przeniesienie): ikona klucza przy serwerze w Ustawienia → Agenci. Stary token przestaje
  działać od razu; na serwerze trzeba uruchomić instalację z nowym tokenem.
- **Usunięcie**: kosz w Ustawienia → Agenci (usuwa serwer z historią i unieważnia token), a na serwerze:

  ```bash
  curl -fsSL http://ADRES-NETPULSE:8000/agent/install.sh | sudo bash -s -- --uninstall
  ```

## Bezpieczeństwo

- Agent tylko czyta: `/proc`, `/sys`, `systemctl list-units`, Docker API (`GET`) i `smartctl`. Nie wykonuje poleceń
  z NetPulse i nie wysyła logów ani listy procesów.
- Działa jako root (wymaga tego SMART i gniazdo Dockera), ale z ograniczeniami systemd: `ProtectSystem=strict`
  (system plików tylko do odczytu), `ProtectHome`, `NoNewPrivileges`, `PrivateTmp`.
- Gniazdo Dockera daje pełną kontrolę nad Dockerem. Jeśli to za dużo, ustaw `DOCKER=off`.
- W sieci domowej panel działa zwykle po HTTP, więc token idzie otwartym tekstem w sieci lokalnej (tak samo jak
  hasło logowania do panelu). Poza siecią domową używaj HTTPS (reverse proxy).

## Dane w bazie

Wartości ze stałymi kolumnami trafiają do dotychczasowych tabel (`device_metrics`, `disk_metrics`, `server_metrics`),
więc karta serwera, wykresy i alerty działają jak dla SNMP. Reszta idzie do ogólnej tabeli **`metrics`**
(hypertable, migracja `0002`): czas, urządzenie, nazwa, klucz, wartość.

| Nazwa | Klucz | Wartość |
|-------|-------|---------|
| `cpu_core_percent` | `cpu0`, `cpu1`, … | % zajętości rdzenia |
| `load5`, `load15` | – | obciążenie |
| `disk_read_bps`, `disk_write_bps` | dysk (`sda`, `nvme0n1`) | B/s |
| `net_rx_bps`, `net_tx_bps` | interfejs | b/s |
| `temp_c` | czujnik (`coretemp/Core 0`) | °C |
| `services_failed` | – | liczba usług w stanie failed |
| `service_up` | usługa (`nginx.service`) | 1 działa, 0 nie |
| `container_up` | kontener | 1 działa, 0 zatrzymany |
| `container_cpu_percent`, `container_mem_bytes` | kontener | % jednego rdzenia, bajty |
| `smart_ok`, `smart_temp_c`, `smart_reallocated` | dysk | 1/0, °C, liczba |

Zdjęcie bieżącego stanu (lista kontenerów, usług, czujników, SMART) jest w `agents.inventory` i trafia do panelu
przez `GET /api/devices/{id}/server` (pole `agent`).

## Co dalej (backlog)

- Reguły alertów na ogólnych metrykach: „kontener zatrzymany”, „usługa failed”, „SMART: błąd”, „temperatura > X”.
- Wykresy z tabeli `metrics` (rdzenie, sieć, dyski, kontenery) i szczegóły serwera na osobnej stronie.
- Informacja w panelu, że agent ma starszą wersję niż NetPulse.
