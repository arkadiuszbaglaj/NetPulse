# Responsywność widgetów względem treści – analiza i propozycja

Stan: 4.11.2026, NetPulse 0.52.0. **Tylko dokument** – nic nie wdrożone, czeka na decyzję.

## Jak to badałem

Na prawdziwym serwerze, na nowym pulpicie „Dashboard - Network” (52 widgety), w podglądzie przeglądarki:

1. Pomiar każdego widgetu w układzie 1440 px: rozmiar karty, ile wysokości zajmuje treść, czy coś się przewija.
2. Eksperyment: dla 14 rodzajów widgetów tymczasowo zmieniałem rozmiar karty (bez zapisu) na S (3×4 kolumny × wiersze,
   271×156 px), M (6×8, 555×324 px), L (12×13, 1121×560 px), „wysoki” (271×560) i „szeroki niski” (1121×156)
   i mierzyłem, jak zachowuje się treść.
3. Ekran 1100 px (laptop): który tryb siatki się włącza i jak układają się widgety.
4. Przegląd kodu: `components/DashboardGrid.tsx`, `components/widgets/*`, `components/charts/PanelChart.tsx`.

## Wyniki eksperymentu

„Zajęte” = jaka część wysokości karty ma treść (reszta to puste miejsce); „przewija” = treść się nie mieści.

| Widget | S (271×156) | M (555×324) | L (1121×560) | Wniosek |
|---|---|---|---|---|
| Wykres (`chart`) | przewija 156/205, wykres 96 px | 95%, wykres 154 px | 97%, wykres 390 px | **rośnie z kartą** ✅, ale w małej karcie legenda wypycha wykres |
| Wykres z legendą-tabelą (4 serie) | przewija, wykres 96 px | przewija 106/124 | 97% | legenda ma pierwszeństwo przed wykresem |
| Mapa cieplna | przewija | 94% | 97% | **rośnie z kartą** ✅ |
| Liczba (`stat`) | 99% | 100% | 100% | wypełnia kartę, ale **liczba zawsze 30 px** – w karcie 1121×560 wygląda jak w małej |
| Wskaźnik (`stat` gauge) | 100% | 73% | 64% | **półkole maks. 192 px**, liczba 24 px – nie rośnie |
| Paski (`bargauge`) | 75% | 36% | **21%** | paski 12 px wysokości, reszta pusta |
| Oś stanów | przewija | 77% | 41% | wiersze stałej wysokości (16 px) |
| PoE | przewija | 59% | 34% | lista portów stałej wysokości |
| Kołowy (`pie`) | przewija | 78% | 66% | **koło zawsze 144 px** |
| Podsumowanie (`summary`) | przewija 156/502 | 82% | **17%** | kafelki stałej wysokości |
| SLA łączy WAN | przewija | 52% | 27% | stały układ |
| Dostępność (`checks`) | przewija | 65% | 38% | stały układ |
| Tabela, lista urządzeń | przewija | przewija | 62–92% | przewijanie w tabeli jest w porządku; brak trybu „mniej kolumn” w wąskiej karcie |

Na prawdziwym pulpicie wygląda to tak:
- „Sieci WiFi – liczba klientów”: zajęte 32% karty,
- „Dyski serwera”: 39%,
- „PoE”: 52%,
- wykresy 324 px wysokości: sam obszar wykresu ma tylko 154 px (48%), resztę zajmują tytuł i legenda-tabela.

### Siatka na laptopie

`DashboardGrid` przełącza się na swobodną siatkę (react-grid-layout) dopiero przy **szerokości siatki ≥ 1024 px**. Liczy
się szerokość siatki, nie ekranu, a menu po lewej zabiera ok. 260 px.

Na ekranie 1100–1280 px (typowy laptop) siatka ma 781–960 px, więc pulpit przechodzi w **tryb dwóch kolumn**, w kolejności
czytania. Skutki w tym trybie:
- giną położenia ustawione na pulpicie (np. „Telewizor” obok „Kabla do bramy”),
- część widgetów zostaje sama na całą szerokość. „Zdarzenia” zajmują 781×553 px, „Telewizor” całą szerokość, bo PoE (4 kolumny) sparowało się z „Kablem”,
- widgety inne niż wykres i liczba (`FIXED_ON_MOBILE`) mają w tym trybie swoją naturalną wysokość, więc rzędy w parze mają
  różne wysokości.

## Przyczyny w kodzie

1. **Stałe rozmiary treści.** Liczba ma `text-3xl`, wskaźnik `text-2xl` i `max-w-48`, pasek `h-3`, wiersz osi stanów `h-4`. Kołowy ma koło 144 px, a kafelki
   podsumowania i SLA mają stałe odstępy. Siatka zmienia rozmiar karty, a treść o tym nie wie.
2. **Brak informacji o rozmiarze karty w widgecie.** Jedynie `PanelChart` ma `ResizeObserver` i dopasowuje
   liczbę podziałek osi do wysokości (`splitNumber`). W całym panelu nie ma ani jednego zapytania kontenerowego
   (`@container`). Tailwind 4.3 obsługuje je wbudowanie, bez dodatkowej paczki.
3. **Legenda wykresu nie ustępuje miejsca.** W siatce legenda dostaje do `max-h-[45%]` z przewijaniem, a wykres ma minimum
   ~96 px. Przy 4 seriach i trzech kolumnach wartości (ostatnia, maks., średnia) legenda-tabela zjada połowę karty.
4. **Próg siatki liczony od szerokości kontenera** (`DESKTOP = 1024` w `DashboardGrid.tsx`) – laptopy dostają tryb dwóch
   kolumn zamiast siatki z mniejszymi kolumnami.
5. **Wysokość ustawia użytkownik ręcznie** (w wierszach po 30 px). Nie ma „dopasuj do treści”, więc łatwo o przewijanie
   (5 takich widgetów poprawiałem ręcznie przy przebudowie pulpitu) albo o pustkę.

## Wdrożone w 0.53.0 (etapy 1 i 2)

- **Kontener zapytań**: komórka siatki (`DashboardGrid.tsx`) ma klasę `np-cell` (`container: np-cell / inline-size`),
  a gdy wysokość karty jest stała (pulpit na komputerze, pełny ekran, widgety z `FIXED_ON_MOBILE` na telefonie) także
  `np-fit` (`container-type: size`). Reguły zależne od wysokości (`@container np-cell (min-height: …)`) działają więc
  tylko tam – w kartach o wysokości z treści widgety wyglądają jak wcześniej.
- **Style** w `frontend/src/index.css` (blok „Dopasowanie treści widgetów do karty”), widgety dostają tylko klasy:
  liczba `np-stat-value`/`np-spark`, wskaźnik `np-gauge`/`np-gauge-value`, kołowy `np-ring`/`np-ring-value`,
  paski `np-bars`/`np-bar`/`np-bar-label`/`np-bar-value` (+ zmienna `--np-rows`), oś stanów `np-tl`/`np-tl-rows`/`np-tl-bar`,
  listy (PoE, SLA, dostępność) `np-list` (+ `--np-row-max`), podsumowanie `np-sum`/`np-sum-tile`/`np-sum-value`/`np-sum-spark`
  (w wąskiej karcie 2×2, wartość liczona od szerokości kafelka, więc nie wychodzi poza kafelek).
- **Legenda wykresu** (`components/charts/legendFit.ts`, `fitLegend`): w karcie mierzonej `ResizeObserver` legenda zostaje
  jak w ustawieniach, gdy wykresowi zostaje ≥ 140 px; inaczej idzie na prawo (szeroka karta), potem zwija się do listy
  nazw (wykres ≥ 70 px), a w najmniejszej karcie znika (nazwy serii są w podpowiedzi). Pełny ekran liczy się tak samo.
  Od 0.54.2 tabela po prawej ma szerokość zależną od liczby kolumn (`rightLegendWidth`: 120 px + 80 px na kolumnę,
  min. 256 px) – przy 256 px i trzech kolumnach nazwy serii nachodziły na wartości.
- **Osie**: `PanelChart` przelicza opcje po zmianie klasy rozmiaru (`plotSizeClass`): przy wąskim wykresie mniejsza
  czcionka osi i mniej opisów czasu.

Pomiar w podglądzie (karty S 271×156, M 366×324, L 460×492): liczba 30 → 44 → 55 px, wskaźnik 192 → 332 → 426 px,
koło 144 → 168 → 212 px, paski i oś stanów wypełniają 91–97% karty, wykresy nie przewijają się w żadnym rozmiarze.
W najmniejszych kartach przewijają się tylko listy z większą liczbą wierszy niż mieści karta.

## Wdrożone w 0.54.0 (etap 3)

- Swobodna siatka już od **720 px** szerokości siatki (wcześniej od 1024 px; `DESKTOP` w `DashboardGrid.tsx`). Na laptopie
  1100–1366 px (siatka ok. 780–1050 px) pulpit ma **te same położenia** co na dużym ekranie, tylko węższe kolumny; treść
  dopasowuje się dzięki etapowi 1. Tablet pionowo (768 px, menu schowane) też dostaje siatkę.
- Dwie kolumny zostają dla 640–720 px. Pary tworzą tylko sąsiedzi **z tego samego rzędu siatki** (zachodzą na siebie
  w pionie, `pairsInColumns`), więc widget z końca rzędu nie łączy się już z początkiem następnego (np. PoE z „Kablem”).
  Para ma wspólną wysokość: wykres i liczba w parze mają wysokość z siatki jako minimum, a nie sztywną wysokość.
- Podsumowanie: kafelek od 160 px (wcześniej 200 px), więc 4 kafelki mieszczą się w rzędzie na laptopie.

Sprawdzone w podglądzie na układzie z serwera (52 widgety): przy 1100 px siatka 781 px, położenia jak na dużym ekranie;
przy 700 px pary z tego samego rzędu, równe wysokości.

## Propozycja (etapy)

### Etap 1 ✅ (0.53.0) – treść skaluje się z kartą (zapytania kontenerowe)

Karta widgetu dostaje `@container` (jedno miejsce: komórka w `DashboardGrid`), a widgety używają wariantów
`@xs:`/`@md:`/`@lg:` i jednostek `cqh`/`cqw`:
- **liczba**: rozmiar liczby z `clamp(1.75rem, 22cqh, 4.5rem)`. Przy karcie 271×156 zostaje jak dziś, przy dużej
  rośnie. Mini-wykres wysoki na ~35% karty zamiast stałych 48 px,
- **wskaźnik**: półkole bez `max-w-48`, mieści się w karcie (`min(100cqw, 160cqh)`), liczba pod nim też z `clamp`,
- **kołowy**: koło w `min(…cqw, …cqh)` zamiast 144 px. Legenda obok koła w szerokiej karcie, pod nim w wąskiej,
- **paski**: wysokość paska `clamp(12px, (100cqh − nagłówek) / liczba wierszy, 32px)`, czyli paski rozkładają się na
  całą kartę. W szerokiej karcie podpis może być szerszy (dziś `w-28` ucina nazwy),
- **oś stanów, PoE, SLA, dostępność**: wiersze rozciągają się (`flex-1` z minimum) zamiast stałych 16–24 px,
- **podsumowanie**: w niskiej, szerokiej karcie kafelki w rzędzie, w wąskiej 2×2, w wysokiej z większą liczbą.

Bez zmian w schemacie pulpitu, w API i w zapisanych pulpitach. Testy: Vitest z `ResizeObserver`/rozmiarem kontenera
dla każdego widgetu oraz sprawdzenie w podglądzie przy rozmiarach S/M/L jak wyżej.

### Etap 2 ✅ (0.53.0) – wykres oddaje miejsce rozsądnie

- Legenda-tabela w małej karcie (wysokość wykresu < ~140 px) **zwija się do listy**, a w bardzo małej (< ~90 px) do samych
  kolorowych kropek z nazwą. Pełna tabela zostaje w trybie pełnego ekranu i w dużej karcie.
- W szerokiej i niskiej karcie legenda przechodzi sama na prawo (dziś tylko gdy ustawi się `placement: "right"`).
- Mniej podziałek i mniejsze czcionki osi przy wąskim wykresie (`splitNumber` liczy dziś tylko wysokość).

### Etap 3 ✅ (0.54.0) – siatka na laptopie

- Próg swobodnej siatki obniżony do ~720 px szerokości siatki, a między 720 a 1024 px siatka ma **te same położenia** z
  węższymi kolumnami. Widgety skalują się dzięki etapowi 1.
- Tryb dwóch kolumn zostaje dla tabletu (< 720 px), z lepszym parowaniem (para = sąsiedzi w tym samym rzędzie siatki,
  a nie kolejni w kolejności czytania) i wspólną wysokością pary.

### Etap 4 – „dopasuj wysokość do treści” (opcjonalnie)

- W trybie edycji przycisk „dopasuj wysokość” przy widgetach z listą (tabela, paski, PoE, oś stanów, alerty).
  Wylicza wiersze siatki z liczby wierszy danych, żeby uniknąć ręcznego zgadywania jak przy przebudowie pulpitu.
- Ewentualnie ostrzeżenie w edycji, gdy treść widgetu się przewija.

## Ryzyka i koszty

- Etap 1 dotyka prawie wszystkich widgetów (`PanelWidgets.tsx`, `OverviewWidgets.tsx`, `SummaryWidget.tsx`,
  `PieWidget.tsx`, `WanSlaWidget.tsx`, widget PoE). To duża zmiana wyglądu, ale bez zmian w danych. Pulpit publiczny
  i pełny ekran korzystają z tych samych komponentów, więc zyskują automatycznie.
- Zapytania kontenerowe działają we wszystkich obecnych przeglądarkach (Chrome/Edge 105+, Safari 16+, Firefox 110+).
- Etap 3 zmienia zachowanie na laptopach – trzeba go sprawdzić na prawdziwym pulpicie przy 1100–1366 px.
- Na telefonie (< 640 px) bez zmian: widgety jeden pod drugim, z naturalną wysokością.

Proponowana kolejność: etap 1 + 2 jako jedna wersja (np. 0.53.0), etap 3 osobno, etap 4 na końcu albo wcale.
