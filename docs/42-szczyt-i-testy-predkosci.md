# Zgodność z UniFi, szczyt ruchu WAN i testy prędkości bramy (od 0.70.0, 0.71.0)

## Po co

Wykres ruchu pokazuje **średnią z 30 sekund** (tyle trwa cykl kolektora). Test prędkości z bramy trwa kilka–kilkanaście
sekund, więc 455 Mb/s wyglądało na wykresie jak ok. 100 Mb/s. Pomiar był poprawny (ilość danych się zgadzała), ale
liczby nie pokrywały się z tym, co pokazuje brama. Sprawdzone 12.11.2026 na UCG Ultra: trzy źródła – brama, serwer
lokalny i VPS przez tunel – opisywały ten sam ruch z różnicą poniżej 1 %, tylko w innym oknie czasu.

Od 0.70.0 są dwie rzeczy:

1. **Testy prędkości bramy** – wynik dokładnie taki, jaki podaje UniFi (zgodność 1:1).
2. **Szczyt ruchu WAN** – obok średniej zapisywana jest najwyższa prędkość z ok. 5 sekund.

## Zgodność wykresów z UCG Ultra (od 0.71.0)

Sprawdzone 13.11.2026 na samej bramie (SSH, tylko odczyt). Network na UCG Ultra trzyma historię w PostgreSQL
(`unifi-network`, port 5434, tabele `stats.stat_buckets_of_5_minutes|1_hour|8_hours|1_month`, wartości w CBOR):

- **WAN** (`wanBySite`, `wanBySiteByDevice`): w kubełku suma bajtów `rxBytes`/`txBytes` i najwyższa chwilowa prędkość
  `maxRxRateBps`/`maxTxRateBps` (bajty/s).
- **Porty** (`portBySiteByDevice`, `byPort`): same bajty – bez najwyższej prędkości. Bajty portów switcha są ułamkowe:
  UniFi rozkłada raporty urządzeń (co kilkadziesiąt sekund) na kubełki.
- **Wykres WAN na pulpicie UniFi rysuje średnią z kubełka** (`AVG_RX_RATE_BPS` w kodzie panelu); najwyższa prędkość jest
  tylko w dymku. Najdrobniejsza historia to 5 minut. Test prędkości 455 Mb/s (20:08) to na wykresie UniFi 26,2 Mb/s
  (kubełek 20:05) z najwyższą chwilową prędkością 663 Mb/s.

**Porównanie przed zmianą** (VPS, 13 h, 156 kubełków): sumy bajtów zgodne z UCG co do 0,1–1 % na WAN i na portach LAN
bramy i switcha. Różnice w pojedynczych kubełkach brały się z czasu, nie z pomiaru: odczyt kolektora co 30 s od chwili
startu przecinał granice kubełków, próbka miała czas odczytu (koniec przedziału), a wykres 24 h miał kubełki 288 s.

Od 0.71.0:

1. **Odczyty równo z zegarem** – kolektor czyta urządzenia o :00 i :30 (`rates.wait_for_slot`), więc każda próbka 30 s
   leży w całości w jednym kubełku 5-minutowym i godzinowym.
2. **Próbka w środku swojego przedziału** – czas wiersza w `interface_metrics` i `wifi_metrics` to środek przedziału
   między odczytami (`rates.sample_times`), a chwila odczytu to środek odpytywania (nie jego początek). Pominięty odczyt
   (60–120 s) dzieli się na części po 30 s, przyrosty błędów idą do ostatniej części (`collector.spread`).
3. **Kubełki wykresów z równej drabinki** – 30 s, 1, 2, 5, 10, 15, 30 min, 1 h (`aggregates.RAW_BUCKETS_S`, w panelu
   `bucketSeconds`): zakres 24 h = 5 minut, 7 dni = godzina, jak w UniFi.
4. **Linia = średnia, najwyższa prędkość w dymku** („26 Mb/s · maks. 455 Mb/s”) – jak w UniFi; szablon „Ruch WAN” nie ma
   już opcji osobnej linii szczytu. Serie szczytu dalej można dodać w edytorze wykresu.
5. **Niemożliwa szybkość w jednym kierunku odrzuca całą próbkę** – router „dogania” zatrzymane liczniki, drugi kierunek
   z tego odczytu też jest zawyżony (12.11.2026: wysyłanie 75,9 Mb/s na łączu 50 Mb/s podniosło 5 minut z 1,6 do 9,2 Mb/s).

Granice zgodności: UplinkView liczy bajty z liczników SNMP z dokładnością do odświeżania licznika w urządzeniu (UCG Ultra
ok. 1 s). Najwyższa prędkość UniFi to wartość chwilowa z bramy, UplinkView – najwyższa średnia z 5 s (odczyt co 0,5 s,
dokładność ok. ±10 %), więc „maks.” bywa niższe niż w UniFi. Na portach switcha UniFi sam rozkłada raporty na kubełki,
stąd pojedyncze kubełki mogą się różnić, choć suma się zgadza. Narzędzie porównania (kubełki z bazy bramy kontra
UplinkView) było jednorazowe, poza repo.

## Testy prędkości bramy

Kontroler UniFi podaje w `stat/device` bramy pole `speedtest-status`: pobieranie, wysyłanie, ping, czas testu, czas
trwania, serwer i interfejs łącza. UplinkView czyta to przy każdym odczycie kontrolera (`unifi.parse_speedtest`) i zapisuje
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
- Wyłączenie: `NETPULSE_PEAK_INTERVAL=0` w `deploy/.env` (domyślnie od 0.71.0 `0.5` – odczyt co pół sekundy; instalacje
  sprzed 0.71.0 mają w `.env` wpisane `1` – zmiana na `0.5` i `sudo uplinkview restart` daje dokładniejszy szczyt).

W panelu szczyt jest **w dymku wykresu** obok średniej (od 0.71.0, „· maks.”), dla serii pobierania i wysyłania źródeł
**Ruch WAN** i **Port**. Osobne serie „Pobieranie – szczyt” i „Wysyłanie – szczyt” (`in_bps_max`, `out_bps_max`) zostały
w edytorze wykresu; wykres dodany w 0.70.x z opcją „Pokaż szczyt” ma je dalej – usuwa się je w Edytuj → zapytanie.

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

**Pierwszy test na serwerach (12.11.2026, 0.70.0):** brama podała 576 / 51 Mb/s, ping 5 ms. Wynik testu zapisał się na obu
serwerach dokładnie (576,0 / 51,0 / 5). Szczyt: VPS 599 / 59 Mb/s (+4 % / +16 %), serwer domowy 341 / 36 Mb/s – za mało.
Przyczyna: na serwerze domowym jest też MikroTik z portem WAN, który nie odpowiadał; próbnik czekał na jego limit czasu
(2 s i ponowienie) przy każdym odczycie, więc bramę czytał co ok. 4 s zamiast co sekundę. Od 0.70.1 próbnik ma własny,
krótki limit czasu (0,8 s, bez ponowień), a router, który nie odpowiada, jest pomijany na 30 s (`READ_TIMEOUT_S`, `BACKOFF_S`).

Test prędkości: pola sprawdzone 12.11.2026 na prawdziwej bramie (UCG Ultra, wynik 455 / 51 Mb/s, ping 6 ms, 17 s) –
z tej odpowiedzi jest test `test_speedtest_from_real_controller_answer`. Szczyt: logika i zapis w testach; odświeżanie
liczników zmierzone na UCG Ultra (ok. 1 s). **Do potwierdzenia na serwerze po aktualizacji:** szczyt w czasie
prawdziwego testu prędkości w porównaniu z wynikiem bramy.
