/** Dane panelu wykresu w czasie: serie z wielu zapytań, statystyki legendy i obszary progów. Czyste funkcje (bez Reacta). */
import { t } from "../../i18n";
import type { Series } from "../../lib/api";
import { METRICS, allSeries, autoColor, type Axis, type ChartConfig, type ColorIndex, type OffsetMinutes, type SeriesConfig, type Source, type Threshold } from "../../lib/layout";
import { toChartRows, type ChartRow } from "./chartData";

export interface PanelLine {
  /** `A.in_bps` – zapytanie i metryka */
  id: string;
  name: string;
  color: ColorIndex;
  axis: Axis;
  rows: ChartRow[];
  /** Seria przesunięta w czasie (porównanie) rysowana jest linią przerywaną */
  dashed: boolean;
}

export interface LineStats {
  last: number | null;
  min: number | null;
  max: number | null;
  avg: number | null;
}

const OFFSET_SUFFIX: Record<Exclude<OffsetMinutes, 0>, Parameters<typeof t>[0]> = {
  60: "chart.offset.60",
  1440: "chart.offset.1440",
  10080: "chart.offset.10080",
};

/** Nazwa serii: własna etykieta, dla WAN „Pobieranie/Wysyłanie” (perspektywa użytkownika), inaczej nazwa metryki.
 * Przy kilku zapytaniach dopisujemy źródło, przy przesunięciu – „(dzień wcześniej)”. */
export function seriesName(source: Source, s: SeriesConfig, offset: OffsetMinutes = 0, sourceLabel?: string): string {
  let name: string;
  if (s.label) name = s.label;
  else if (source.kind === "wan" && s.key === "in_bps") name = t("chart.traffic.in");
  else if (source.kind === "wan" && s.key === "out_bps") name = t("chart.traffic.out");
  else name = METRICS[s.key] ? t(METRICS[s.key].label) : s.key;
  if (!s.label && sourceLabel) name = `${sourceLabel}: ${name}`;
  return offset && !s.label ? `${name} ${t(OFFSET_SUFFIX[offset])}` : name;
}

/** Serie wykresu ze wszystkich zapytań. `sourceLabel` daje nazwę źródła, gdy zapytań o różnych źródłach jest kilka. */
export function buildLines(config: ChartConfig, data: Map<string, Series | undefined>, sourceLabel: (s: Source) => string): PanelLine[] {
  const distinctSources = new Set(config.queries.map((q) => JSON.stringify(q.source))).size > 1;
  return allSeries(config).map(({ query, series }, i) => {
    const d = data.get(query.id);
    const offset = query.offset_min ?? 0;
    return {
      id: `${query.id}.${series.key}`,
      name: seriesName(query.source, series, offset, distinctSources ? sourceLabel(query.source) : undefined),
      color: series.color ?? autoColor(i),
      axis: series.axis ?? "left",
      rows: d ? toChartRows(d.points, series.key, d.interval_s) : [],
      dashed: offset > 0,
    };
  });
}

export function lineStats(rows: ChartRow[]): LineStats {
  const values = rows.map((r) => r[1]).filter((v): v is number => v != null && Number.isFinite(v));
  if (values.length === 0) return { last: null, min: null, max: null, avg: null };
  return {
    last: values[values.length - 1],
    min: Math.min(...values),
    max: Math.max(...values),
    avg: values.reduce((a, b) => a + b, 0) / values.length,
  };
}

/** Pasy tła od każdego progu do następnego (ostatni do `top`), w kolorze progu. */
export function thresholdBands(thresholds: Threshold[], top: number): { from: number; to: number; color: ColorIndex }[] {
  const sorted = [...thresholds].sort((a, b) => a.value - b.value);
  return sorted
    .map((th, i) => ({ from: th.value, to: sorted[i + 1]?.value ?? Math.max(top, th.value), color: th.color }))
    .filter((b) => b.to > b.from);
}
