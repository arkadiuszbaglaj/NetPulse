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
- **Wykres i liczba wypełniają komórkę** (kontekst `GridCellContext`); poza pulpitem (strony szczegółów) wykres ma
  dalej wysokość z konfiguracji. Pole „Wysokość” zniknęło z edytora wykresu.
- **Sekcje** (`type: "section"`, `config.title`, `config.collapsed`): nagłówek na całą szerokość; zwinięcie ukrywa
  widgety pod nim do następnej sekcji, a widgety niżej dosuwają się do góry. „Zwinięta przy otwarciu” to ustawienie
  sekcji; kliknięcia oglądającego pamięta przeglądarka (`localStorage`, osobno dla każdego pulpitu). W trybie edycji
  wszystkie sekcje są rozwinięte.
- **Telefon** (< 1024 px): widgety jeden pod drugim w kolejności czytania (z góry na dół, w wierszu od lewej);
  wykres i liczba mają wysokość z siatki, reszta – swoją.
- **Podgląd bez serwera**: `npm --prefix frontend run mock` (atrapa API z pulpitem, kolekcjami i stanami) +
  `npm --prefix frontend run dev`; konfiguracja w `.claude/launch.json`.
