/** Mapa cieplna (0.37.0): próbki metryki w kratkach godzina × dzień tygodnia albo × data. Czyste funkcje bez Reacta.
 * Godziny i dni w strefie czasowej przeglądarki – serwer jej nie zna. */
import type { SeriesPoint } from "./api";

export type HeatmapGroup = "weekday" | "date";
export type HeatmapReduce = "avg" | "max";

/** Tydzień w minutach – jedno zapytanie do API (do 7 dni dane surowe, kubełki ok. 30 min). */
export const HEATMAP_WEEK = 7 * 24 * 60;

export interface HeatmapRow {
  /** Poniedziałek = 0 … niedziela = 6, albo data „2026-10-29” */
  key: string;
  /** Wartość w każdej z 24 godzin (null = brak próbek) */
  cells: (number | null)[];
}

export interface HeatmapGrid {
  rows: HeatmapRow[];
  min: number | null;
  max: number | null;
}

const pad = (n: number) => String(n).padStart(2, "0");
const dateKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** Dzień tygodnia od poniedziałku (getDay: niedziela = 0). */
export const weekday = (d: Date) => (d.getDay() + 6) % 7;

/** Kratki z punktów: kluczem wiersza dzień tygodnia albo data, kolumną godzina. Wiersze dat – od najstarszej
 * do dziś, wszystkie dni z `days` (puste też, żeby przerwa w danych była widoczna). */
export function heatmapGrid(points: SeriesPoint[], key: string, group: HeatmapGroup, reduce: HeatmapReduce, days: number, now = new Date()): HeatmapGrid {
  const sums = new Map<string, { sum: number; max: number; n: number }[]>();
  for (const p of points) {
    const v = p.values[key];
    if (v == null || !Number.isFinite(v)) continue;
    const d = new Date(p.time);
    const row = group === "weekday" ? String(weekday(d)) : dateKey(d);
    const cells = sums.get(row) ?? Array.from({ length: 24 }, () => ({ sum: 0, max: -Infinity, n: 0 }));
    const c = cells[d.getHours()];
    c.sum += v;
    c.max = Math.max(c.max, v);
    c.n += 1;
    sums.set(row, cells);
  }
  const keys =
    group === "weekday"
      ? ["0", "1", "2", "3", "4", "5", "6"]
      : Array.from({ length: days }, (_, i) => dateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1 - i))));
  let min: number | null = null;
  let max: number | null = null;
  const rows = keys.map((k) => ({
    key: k,
    cells: (sums.get(k) ?? []).length
      ? sums.get(k)!.map((c) => {
          if (c.n === 0) return null;
          const v = reduce === "max" ? c.max : c.sum / c.n;
          min = min == null ? v : Math.min(min, v);
          max = max == null ? v : Math.max(max, v);
          return v;
        })
      : Array<number | null>(24).fill(null),
  }));
  return { rows, min, max };
}

/** Natężenie koloru kratki 0–1 względem najmniejszej i największej wartości (przy jednej wartości – pełne). */
export function intensity(v: number | null, min: number | null, max: number | null): number {
  if (v == null || min == null || max == null) return 0;
  return max > min ? (v - min) / (max - min) : 1;
}
