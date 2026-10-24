import type { SeriesPoint } from "../../lib/api";

export type ChartRow = [timeMs: number, value: number | null];

/**
 * Zamienia punkty z API na wiersze wykresu. Gdy między dwoma punktami minęło więcej niż 2,5 odstępu
 * (urządzenie nie odpowiadało), wstawia pusty punkt – wykres pokazuje lukę zamiast łączyć odległe próbki.
 */
export function toChartRows(points: SeriesPoint[], key: string, intervalS: number): ChartRow[] {
  const gapMs = intervalS * 2.5 * 1000;
  const rows: ChartRow[] = [];
  let prev: number | null = null;
  for (const p of points) {
    const t = new Date(p.time).getTime();
    if (prev !== null && t - prev > gapMs) rows.push([prev + intervalS * 1000, null]);
    rows.push([t, p.values[key] ?? null]);
    prev = t;
  }
  return rows;
}
