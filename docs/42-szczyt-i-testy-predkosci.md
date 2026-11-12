# Szczyt ruchu WAN i testy prędkości bramy (od 0.70.0)

## Po co

Wykres ruchu pokazuje **średnią z 30 sekund** (tyle trwa cykl kolektora). Test prędkości z bramy trwa kilka–kilkanaście
sekund, więc 455 Mb/s wyglądało na wykresie jak ok. 100 Mb/s. Pomiar był poprawny (ilość danych się zgadzała), ale
liczby nie pokrywały się z tym, co pokazuje brama. Sprawdzone 12.11.2026 na UCG Ultra: trzy źródła – brama, serwer
lokalny i VPS przez tunel – opisywały ten sam ruch z różnicą poniżej 1 %, tylko w innym oknie czasu.

Od 0.70.0 są dwie rzeczy:

1. **Testy prędkości bramy** – wynik dokładnie taki, jaki podaje UniFi (zgodność 1:1).
2. **Szczyt ruchu WAN** – obok średniej zapisywana jest najwyższa prędkość z ok. 5 sekund.

## Testy prędkości bramy

Kontroler UniFi podaje w `stat/device` bramy pole `speedtest-status`: pobieranie, wysyłanie, ping, czas testu, czas
trwania, serwer i interfejs łącza. NetPulse czyta to przy każdym odczycie kontrolera (`unifi.parse_speedtest`) i zapisuje
każdy **nowy** test do tabeli `metrics` na bramie, z czasem samego testu i kluczem = interfejs łącza (`eth4`):
`speedtest_down_bps`, `speedtest_up_bps`, `speedtest_ping_ms` (`unifi_collector.save_speedtest`). Ten sam wynik odczytany
ponownie trafia w ten sam wiersz (klucz główny), więc nie ma powtórek.

- Kontroler podaje **tylko ostatni test** – historia buduje się od aktualizacji do 0.70.0; wcześniejszych testów nie ma.
- Test nieudany, trwający albo bez prędkości jest pomijany.
- W panelu: źródło wykresu **„Łącze WAN: testy prędkości bramy”** (`speedtest`; urządzenie = brama, klucz = łącze; serie
  Pobieranie, Wysyłanie, Ping) i szablon **Dodaj widget → Internet → „Testy prędkości bramy”** (wykres słupkowy, 7 dni).
  Kafelek „ostatni test” to zwykły widget „Liczba” z tym źródłem, wartością „ostatnia” i własnym zakresem (np. 7 dni).
- Wymaga modułu UniFi i kontrolera z kluczem API. Bez zmian w bazie.

## Szczyt ruchu WAN

Moduł `netpulse/peaks.py` (pętla w kolektorze obok głównej) czyta **same liczniki portów WAN co sekundę** – jedno małe
zapytanie SNMP na router – i dla każdego cyklu pamięta najwyższą prędkość z okna co najmniej 5 s. Kolektor zapisuje ją
obok średniej: `interface_metrics.in_bps_max` i `out_bps_max` (migracja 0018).

- **Tylko porty z rolą WAN** na urządzeniach SNMP (także porty ustawione w Ustawienia → Łącza WAN). Pozostałe porty mają
  samą średnią.
- **Okno 5 s**: krótszy skok jest uśredniany w oknie (2 s × 500 Mb/s to szczyt 200 Mb/s), dłuższy widać w pełni.
- **Prędkość liczona między zmianami licznika**, nie między odczytami. Urządzenia odświeżają liczniki SNMP co sekundę
  (UCG Ultra, zmierzone 12.11.2026) albo co kilka sekund; przy rzadszym odświeżaniu okno samo się wydłuża, zamiast
  pokazywać „zero, potem podwójnie”.
- **Dokładność ok. ±20 %** dla okna 5 s: chwilę zmiany licznika znamy z dokładnością do sekundy. Szczyt to przybliżenie
  krótkich skoków, a nie wynik testu prędkości – dokładne liczby testu daje źródło „testy prędkości bramy”.
- Szczyt nigdy nie jest niższy od średniej z cyklu; wartość ponad możliwości łącza (1,1× prędkości portu Ethernet) jest odrzucana.
- **Zakresy powyżej 7 dni** czytają agregaty godzinowe, w których szczytu nie ma – seria jest wtedy pusta. Dane sprzed
  0.70.0 też nie mają szczytu.
- Wyłączenie: `NETPULSE_PEAK_INTERVAL=0` w `deploy/.env` (domyślnie `1` – odczyt co sekundę).

W panelu szczyt to dwie nowe serie źródeł **Ruch WAN** i **Port**: „Pobieranie – szczyt” i „Wysyłanie – szczyt”
(`in_bps_max`, `out_bps_max`). Włączenie:

- nowy wykres: Dodaj widget → Internet → „Ruch WAN” → opcja **„Pokaż szczyt”**,
- istniejący wykres: Edytuj → zaznacz serie szczytu w zapytaniu.

Domyślne pulpity zostają bez szczytu (na łączu z samym spokojnym ruchem dwie dodatkowe linie nic nie wnoszą).

## API

- `GET /api/dashboard/traffic` – oprócz `in_bps`, `out_bps` zwraca `in_bps_max`, `out_bps_max` (maksimum z kubełka; suma po łączach WAN).
- `GET /api/interfaces/{id}/metrics` – to samo dla jednego portu.
- `GET /api/devices/{id}/agent-metrics?source=speedtest&key=<łącze>` – testy prędkości (`down_bps`, `up_bps`, `ping_ms`).
- `GET /api/devices/{id}/agent-keys` – łącza z testem z ostatnich 30 dni w polu `speedtest` (inne źródła: ostatnia godzina).

## Dla programisty

- `peaks.PeakTracker` (czysta logika, `test_peaks.py`), `peaks.PeakSampler` (pętla; kolektor odbiera przez `take`).
  `Collector(peaks=None)` działa jak dotąd – testy i polecenia CLI nie uruchamiają próbnika.
- Kolumny `…_max` w `api/metrics._series` agreguje `max`, pozostałe `avg`; agregat godzinowy pomija kolumny, których nie ma.
- Migracja 0018 dodaje kolumny osobnymi instrukcjami – tabela ma kompresję TimescaleDB (zasady w `docs/13-migracje-bazy.md`).
- Atrapa `frontend/dev/mock-api.mjs` zwraca szczyt i przykładowe testy prędkości.

## Stan

Test prędkości: pola sprawdzone 12.11.2026 na prawdziwej bramie (UCG Ultra, wynik 455 / 51 Mb/s, ping 6 ms, 17 s) –
z tej odpowiedzi jest test `test_speedtest_from_real_controller_answer`. Szczyt: logika i zapis w testach; odświeżanie
liczników zmierzone na UCG Ultra (ok. 1 s). **Do potwierdzenia na serwerze po aktualizacji:** szczyt w czasie
prawdziwego testu prędkości w porównaniu z wynikiem bramy.
