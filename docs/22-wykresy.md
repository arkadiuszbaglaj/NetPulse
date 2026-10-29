# Przebudowa wykresów i pulpitu (od 0.26.0)

Cel: większa swoboda w układaniu pulpitu, na wzór Grafany (zrzuty w folderze `graf/`, poza repozytorium).
Decyzje użytkownika (2026-10-25): wszystkie funkcje wykresu w czasie, nowe panele „liczba z mini-wykresem”,
„paski”, „tabela i oś stanów”, swobodna siatka, praca etapami.

## Etapy

| Etap | Wersja | Zakres |
|------|--------|--------|
| A ✅ | 0.26.0 | Wykres w czasie: wiele źródeł na jednym wykresie, druga oś Y, progi (linia / tło), legenda jako lista albo tabela z min / max / średnią / ostatnią, klik w legendzie ukrywa serię, serie piętrowane (stos), porównanie w czasie (ta sama seria godzinę, dzień albo tydzień wcześniej). Nowy edytor panelu: duże okno z podglądem na żywo. |
| B ✅ | 0.27.0 | Nowe panele: liczba z mini-wykresem (kolor z progów), paski (bar gauge, np. zajętość wszystkich dysków), tabela (porty, klienci, dyski z sortowaniem), oś stanów (up/down portów i urządzeń w czasie). |
| C ✅ | 0.28.0 | Swobodna siatka: przeciąganie i rozciąganie paneli myszką (szerokość i wysokość), sekcje z nagłówkami do zwijania. Migracja obecnych układów kolumnowych. |
| D ✅ | 0.32.0 | Powiększanie zaznaczeniem myszą (wszystkie wykresy strony, „Wróć”), wspólny kursor wykresów, klikalne wiersze tabel i pasków oraz węzły mapy sieci. |
| E ✅ | 0.33.0 | Liczba jako wskaźnik kołowy i ze zmianą względem poprzedniego okresu, pełny ekran widgetu, eksport wykresu do CSV i PNG. |
| F ✅ | 0.34.0 | Zdarzenia na osi czasu (adnotacje): alerty, restarty urządzeń i przełączenia WAN jako pionowe kreski z opisem w podpowiedzi. |

Każdy etap to osobna wersja do sprawdzenia na serwerze.

## Etap A – model wykresu

Widget `chart` dostaje nową konfigurację. Stara (jedno `source` + `series`) jest zamieniana na nową przy odczycie
(`layout_schemas.py`, `ChartConfig` – walidator `mode="before"`; w panelu `upgradeChartConfig` w `lib/layout.ts`),
więc zapisane pulpity działają bez zmian, a po pierwszym zapisie są już w nowym formacie.

```jsonc
{
  "title": "Ruch i CPU",
  "queries": [                        // 1–6 zapytań, razem do 12 serii
    { "id": "A", "source": { "kind": "wan" }, "offset_min": 0,
      "series": [ { "key": "in_bps", "color": 1, "label": null, "axis": "left" } ] },
    { "id": "B", "source": { "kind": "wan" }, "offset_min": 1440,     // ten sam ruch dzień wcześniej
      "series": [ { "key": "in_bps", "color": 5, "label": "Wczoraj", "axis": "left" } ] },
    { "id": "C", "source": { "kind": "device", "id": 1 }, "offset_min": 0,
      "series": [ { "key": "cpu_percent", "color": 3, "axis": "right" } ] }
  ],
  "chart": "area", "stack": false, "smooth": false, "unit": "bits",
  "axes": { "left": { "min": null, "max": null, "label": null }, "right": { "min": 0, "max": 100, "label": "CPU" } },
  "thresholds": [ { "value": 800000000, "color": 4 } ],     // w jednostkach surowych osi lewej
  "threshold_style": "line",                                  // off | line | area | line_area
  "legend": { "mode": "table", "placement": "bottom", "values": ["last", "max", "avg"] },
  "range_min": null, "refresh_s": null, "height": "md"
}
```

- **Przesunięcie w czasie** (`offset_min`: 0, 60, 1440, 10080): API metryk przyjmuje parametr `offset`
  (minuty) – okno `[teraz − offset − zakres, teraz − offset]`; panel przesuwa punkty o `offset`, żeby nałożyły się
  na bieżące. Pulpit publiczny przepuszcza `offset` tylko taki, jaki ma zapytanie w tym pulpicie.
- **Osie**: seria ma `axis` lewa / prawa; jednostka osi = jednostka pierwszej serii na tej osi. Edytor przy dodaniu
  serii o innej jednostce niż oś lewa sam przenosi ją na prawą.
- **Stos** dotyczy serii na tej samej osi (piętrowane osobno lewa i prawa).
- **Legenda**: wartości liczone w panelu z punktów widocznego zakresu.

## Etap B – nowe panele (0.27.0)

| Widget | Dane | Ustawienia |
|--------|------|------------|
| `stat` – Liczba | źródło wykresu (`source` + `key`), te same ścieżki co wykres | wartość ostatnia / średnia / maks. / min. z zakresu, mini-wykres, kolor bazowy i progi (kolor liczby albo tła) |
| `bargauge` – Paski | kolekcja (`collection` + `key`) | min / maks. (puste: 100 dla %, inaczej największa), układ poziomy / pionowy, kolejność, limit, progi |
| `table` – Tabela | kolekcja + `columns` | sortowanie domyślne (klik w nagłówek zmienia je na pulpicie), limit wierszy |
| `state_timeline` – Oś stanów | `GET /api/states` | urządzenia i porty (do 20), pusta lista = wszystkie urządzenia |

**Kolekcje** (`GET /api/collections/{kind}`, `api/panels.py`): wiersz na obiekt z bieżącymi wartościami (ostatnie 5 min).

| Kolekcja | Urządzenie | Wartości |
|----------|------------|----------|
| `devices` | – | `up`, `cpu_percent`, `mem_used_percent`, `poll_ms`, `uptime_s` |
| `ports` | wymagane | `up`, `in_bps`, `out_bps`, `speed_mbps` |
| `disks` | wymagane (serwer) | `used_percent`, `used_bytes`, `free_bytes`, `total_bytes` |
| `wifi` | opcjonalne | `clients`, `rx_bps`, `tx_bps` |
| `containers` | wymagane (agent) | `up`, `cpu_percent`, `mem_bytes` |
| `guests` | opcjonalne (węzeł Proxmox) | `up`, `cpu_percent`, `mem_bytes`, `mem_percent`, `rx_bps`, `tx_bps`, `uptime_s`, `backup_age_h` (od 0.31.0; bez szablonów, tagów i adresów; nowe VM/LXC pojawiają się same) |
| `services` | wymagane (agent) | `up`, `mem_bytes`, `uptime_s` (od 0.29.0; `up` puste, gdy usługa zmienia stan) |
| `clients` | – | `signal_dbm`, `rx_rate_kbps`, `tx_rate_kbps`, `connected_s` (bez MAC-ów: kluczem jest kolejność) |

**Stany** (`GET /api/states?devices=1,2&interfaces=7&minutes=60`): kubełki jak w wykresach, `bool_and(reachable)` dla
urządzeń i `bool_and(oper_up)` dla portów; kubełek bez próbek = „brak danych”, ale przerwa do 3 interwałów przejmuje
stan sprzed niej (spóźniony odczyt). Surowe dane są trzymane 30 dni – dalej oś pokazuje „brak danych”.

Pulpit publiczny: kolekcje tylko takie, jakie mają paski i tabele pulpitu (rodzaj + urządzenie), stany tylko dla
dokładnie tego zestawu pozycji, liczba – ścieżka jej źródła (`public.py`, `resolve()`).

## Etap C – swobodna siatka i sekcje (0.28.0)

- **Pozycje**: każdy widget ma `x`, `y` (kolumna i wiersz) i `h` (wysokość w wierszach); `w` to dowolne 1–12.
  Wiersz = 30 px + 12 px odstępu (`rowsToPx`). Schemat: `layout_schemas.py` (pola opcjonalne, `x + w ≤ 12`).
- **Pulpity sprzed 0.28.0** nie mają pozycji: panel układa je po kolei jak dawne kolumny (`placeWidgets`,
  wysokości z `defaultHeight`), a pierwszy zapis w trybie edycji zapisuje już pozycje wszystkich widgetów.
- **Edycja** (od 1024 px): `react-grid-layout` 2.3 – przeciąganie za uchwyt (`.np-drag`), rozciąganie za prawy dolny
  róg, prawą i dolną krawędź; reszta widgetów rozsuwa się i dosuwa do góry. Z klawiatury: strzałki na uchwycie
  przesuwają o jedną kratkę, Shift + strzałki zmieniają rozmiar (`nudgeWidget`).
- **Wykres, liczba i „Aktywne łącze WAN” wypełniają komórkę** (kontekst `GridCellContext`, od 0.31.3 też `ChartCard`
  z `fill`); poza pulpitem (strony szczegółów) wykres ma dalej wysokość z konfiguracji. Pole „Wysokość” zniknęło z edytora wykresu.
- **Sekcje** (`type: "section"`, `config.title`, `config.collapsed`): nagłówek na całą szerokość; zwinięcie ukrywa
  widgety pod nim do następnej sekcji, a widgety niżej dosuwają się do góry. „Zwinięta przy otwarciu” to ustawienie
  sekcji; kliknięcia oglądającego pamięta przeglądarka (`localStorage`, osobno dla każdego pulpitu). W trybie edycji
  wszystkie sekcje są rozwinięte.
- **Telefon i tablet** (< 1024 px): widgety w kolejności czytania (z góry na dół, w wierszu od lewej); wykres,
  liczba i wykres łącza WAN mają wysokość z siatki, reszta – swoją. Od 0.31.3 przy szerokości od 640 px w dwóch
  kolumnach: widget o szerokości 8+ (z 12), sekcja i wąski widget bez pary zajmują obie (`fullWidthInColumns`).
  W trybie edycji zamiast uchwytu są przyciski w górę i w dół (`swapInReadingOrder` – zamiana miejscami z sąsiadem;
  na komputerze nakładające się widgety rozsuwa siatka).
- **Pasy stanów** (oś stanów, pasy łączy WAN – `components/charts/StateBar.tsx`): szczegóły odcinka po najechaniu,
  a po kliknięciu albo dotknięciu – pod pasem (na telefonie nie ma podpowiedzi `title`).
- **Progi przy stosie**: pasy progów sięgają szczytu stosu (suma serii, `leftTop`), nie najwyższej pojedynczej serii.
- **Podgląd bez serwera**: `npm --prefix frontend run mock` (atrapa API z pulpitem, kolekcjami i stanami) +
  `npm --prefix frontend run dev`; konfiguracja w `.claude/launch.json`.

## Etap D – powiększanie, wspólny kursor, linki (0.32.0)

- **Powiększanie zaznaczeniem** (`components/charts/ZoomLayer.tsx`, stan `zoom` w `lib/refresh.tsx`): przeciągnięcie
  myszą po obszarze wykresu zawęża oś czasu **wszystkich** wykresów strony. Tylko mysz (`pointerType`) – na ekranie
  dotykowym przeciąganie przewija stronę. Kolejne powiększenia idą na stos; „Wróć” (przy wyborze zakresu i ikona
  lupy w rogu wykresu) albo dwuklik cofa o jedno, wybór zakresu i przejście na inną stronę kończą powiększenie.
- **Dokładniejsze dane**: widget „wykres” (`useChartQueries`) pyta API o samo okno – `minutes` i `offset`
  z `zoomWindow` (przesunięcie w pełnych minutach w dół, zakres co najmniej 5 min); `fetchSeries(…, back)` cofa okno
  bez przesuwania czasu (w odróżnieniu od porównania `offset_min`). Pozostałe wykresy (`TimeSeriesChart`: łącze WAN,
  port, klient) przycinają dane, które już mają. Oś Y skaluje się do widocznego fragmentu. Powiększenie wstrzymuje
  automatyczne odświeżanie wykresów (okno jest stałe).
- **Pulpit publiczny** nie powiększa (`canZoom = false`): jego API przyjmuje tylko zakresy i przesunięcia z pulpitu.
- **Wspólny kursor** (`components/charts/chartSync.ts`): najechanie na wykres pokazuje podpowiedź w tej samej chwili
  na pozostałych. Synchronizacja po czasie (`convertToPixel`), nie po pikselach jak `echarts.connect` – wykresy mają
  różne szerokości i osie.
- **Linki**: nazwa wiersza tabeli i paska prowadzi do strony szczegółów (`rowLink` w `lib/panels.ts`: urządzenie,
  port, serwer dla dysków/kontenerów/usług, listy klientów, sprawdzeń i Proxmoxa – w wierszu nie ma MAC-a ani węzła),
  nazwa węzła mapy sieci – do strony urządzenia. Na pulpicie publicznym bez linków (`useDetailLinks`).
- **Atrapa API** (`frontend/dev/mock-api.mjs`) uwzględnia `offset` w danych ruchu i metryk, jak prawdziwe API.

## Etap E – wskaźnik, zmiana, pełny ekran, eksport (0.33.0)

- **Liczba** (`StatWidget`): nowe pola `display` (`number` | `gauge`), `max` (koniec skali wskaźnika; puste = 100
  dla %, inaczej maksimum z zakresu) i `show_change`. Zmiana = ta sama redukcja (ostatnia, średnia…) policzona dla
  poprzedniego okresu tej samej długości (`fetchSeries(…, offset = zakres)`, `percentChange`); kolor neutralny,
  kierunek pokazuje strzałka. Pulpit publiczny przepuszcza to przesunięcie tylko dla liczby z `show_change`
  (`public.resolve`). Stare układy dostają wartości domyślne (schemat `StatConfig`).
- **Pełny ekran** (`DashboardGrid` → `Fullscreen`, kontekst `WidgetExpandContext`): okno w portalu nad całym
  panelem (komórki siatki są przesuwane `transform`, więc `fixed` w nich nie działa), Escape zamyka, fokus wraca.
  Mają go widgety z nagłówkiem `WidgetActions`: wykres, liczba, paski, tabela, oś stanów i łącze WAN. W trybie
  edycji wyłączony.
- **Menu „⋯” wykresu** (`components/widgets/WidgetActions.tsx`, też w portalu – komórka przycina treść): pełny
  ekran, **CSV** (`linesToCsv`: średnik, przecinek dziesiętny, BOM dla Excela, czas lokalny, wartości surowe
  z jednostką w nagłówku, wiersz na każdą chwilę dowolnej serii) i **PNG** (`getDataURL` ECharts, tło karty,
  2× rozdzielczość). Nazwa pliku z tytułu i chwili (`lib/download.ts`). Jedna akcja = sam przycisk z ikoną.

## Etap F – zdarzenia na osi czasu (0.34.0)

- **API** `GET /api/events?minutes=&offset=` (`api/events.py`, to samo okno co metryki, także powiększony fragment):
  alert (początek, `alert`) i jego koniec (`alert_end`) z historii `alerts` (z `severity`, `device_id` i
  `interface_id` z podmiotu `i<id>`), **restart** urządzenia – spadek `uptime_s` między próbkami `device_metrics`
  (czas = próbka minus nowy uptime) i **przełączenie WAN** – ta sama logika co historia łączy (`wan.switches`).
  Restarty i przełączenia tylko do 31 dni wstecz (liczone z surowych próbek), alerty w każdym zakresie; najwyżej
  300 najnowszych. Urządzenia wyłączonych modułów pomijane. Pulpit publiczny tego nie dostaje (403 z `resolve`,
  panel nie pyta – `useDetailLinks`).
- **Wykres** (`PanelChart`): pionowe przerywane kreski w osobnej pustej serii (markLine pierwszej serii zajmują
  progi), kolor: alert krytyczny/ostrzeżenie/info, koniec – zielony, restart – fiolet (`--chart-6`), przełączenie WAN
  – akcent. Opis w podpowiedzi osi, gdy kursor jest bliżej zdarzenia niż pół kubełka (też we wspólnym kursorze).
- **Które zdarzenia** (`annotations` w konfiguracji wykresu, edytor → Wygląd, `eventsFor` w `lib/events.ts`):
  `auto` (domyślnie) – wykres urządzenia lub z agenta: jego restarty i alerty (też portów), wykres portu: ten port
  i restarty jego urządzenia; wykres ogólny (WAN, WiFi, serwer, sprawdzenie): przełączenia WAN i alerty bez
  urządzenia. `all` – wszystkie, `off` – żadne. W trybie „Na żywo” bez zdarzeń.
