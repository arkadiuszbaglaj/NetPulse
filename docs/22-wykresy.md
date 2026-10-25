# Przebudowa wykresów i pulpitu (od 0.26.0)

Cel: większa swoboda w układaniu pulpitu, na wzór Grafany (zrzuty w folderze `graf/`, poza repozytorium).
Decyzje użytkownika (2026-10-25): wszystkie funkcje wykresu w czasie, nowe panele „liczba z mini-wykresem”,
„paski”, „tabela i oś stanów”, swobodna siatka, praca etapami.

## Etapy

| Etap | Wersja | Zakres |
|------|--------|--------|
| A ✅ | 0.26.0 | Wykres w czasie: wiele źródeł na jednym wykresie, druga oś Y, progi (linia / tło), legenda jako lista albo tabela z min / max / średnią / ostatnią, klik w legendzie ukrywa serię, serie piętrowane (stos), porównanie w czasie (ta sama seria godzinę, dzień albo tydzień wcześniej). Nowy edytor panelu: duże okno z podglądem na żywo. |
| B | 0.27.0 | Nowe panele: liczba z mini-wykresem (kolor z progów), paski (bar gauge, np. zajętość wszystkich dysków), tabela (porty, klienci, dyski z sortowaniem), oś stanów (up/down portów i urządzeń w czasie). |
| C | 0.28.0 | Swobodna siatka: przeciąganie i rozciąganie paneli myszką (szerokość i wysokość), sekcje z nagłówkami do zwijania. Migracja obecnych układów kolumnowych. |

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
