/** Skąd bierze dane wykres: ścieżki API dla każdego rodzaju źródła i normalizacja odpowiedzi. */
import { useQueries } from "@tanstack/react-query";
import { t } from "../../i18n";
import { get, type Series, type SeriesPoint } from "../../lib/api";
import type { ChartConfig, ChartQuery, Source } from "../../lib/layout";
import { useRefresh } from "../../lib/refresh";

/** Powyżej 7 dni API liczy wykres z agregatów godzinowych: kubełki to pełne godziny (backend/netpulse/aggregates.py). */
const RAW_MAX_MINUTES = 7 * 24 * 60;
const LONG_BUCKETS_H = [1, 2, 3, 6, 12, 24, 48];

/** Ten sam rozmiar kubełka co w API: ~300 punktów, nie mniej niż 30 s. */
export function bucketSeconds(minutes: number): number {
  const raw = Math.floor((minutes * 60) / 300);
  if (minutes <= RAW_MAX_MINUTES) return Math.max(30, raw);
  return (LONG_BUCKETS_H.find((h) => h * 3600 >= raw) ?? LONG_BUCKETS_H[LONG_BUCKETS_H.length - 1]) * 3600;
}

/** Ścieżka API danych źródła; `offset` (minuty) przesuwa okno wstecz – porównanie z wcześniejszym okresem. */
export function sourcePath(source: Source, minutes: number, offset = 0): string {
  const shift = offset > 0 ? `&offset=${offset}` : "";
  switch (source.kind) {
    case "wan":
      return `/api/dashboard/traffic?minutes=${minutes}${shift}`;
    case "wifi_total":
      return `/api/dashboard/wifi?minutes=${minutes}${shift}`;
    case "interface":
      return `/api/interfaces/${source.id}/metrics?minutes=${minutes}${shift}`;
    case "device":
      return `/api/devices/${source.id}/metrics?minutes=${minutes}${shift}`;
    case "wifi_network":
      return `/api/wifi/${source.id}/metrics?minutes=${minutes}${shift}`;
    case "server":
      return `/api/system/metrics?minutes=${minutes}${shift}`;
    default:
      return `/api/devices/${source.id}/agent-metrics?source=${source.kind}&key=${encodeURIComponent(source.key)}&minutes=${minutes}${shift}`;
  }
}

const AGENT_TITLE = {
  agent_net: "ce.source.agent_net",
  agent_disk: "ce.source.agent_disk",
  agent_temp: "ce.source.agent_temp",
  agent_container: "ce.source.agent_container",
  pve_guest: "ce.source.pve_guest",
} as const;

/** Endpointy pulpitu zwracają `{interval_s, points}`, pozostałe samą listę punktów.
 * Dane z przesunięciem dostają czas przesunięty do przodu, żeby nałożyły się na bieżące. */
export async function fetchSeries(source: Source, minutes: number, offset = 0): Promise<Series> {
  const raw = await get<Series | SeriesPoint[]>(sourcePath(source, minutes, offset));
  const series = Array.isArray(raw) ? { interval_s: bucketSeconds(minutes), points: raw } : raw;
  if (!offset) return series;
  const ms = offset * 60_000;
  return { ...series, points: series.points.map((p) => ({ ...p, time: new Date(new Date(p.time).getTime() + ms).toISOString() })) };
}

export function defaultTitle(source: Source): string {
  switch (source.kind) {
    case "wan":
      return t("chart.traffic.title");
    case "wifi_total":
      return t("chart.wifi.title");
    case "interface":
      return t("widget.title.interface", { id: source.id });
    case "device":
      return t("widget.title.device", { id: source.id });
    case "wifi_network":
      return t("widget.title.wifi_network", { id: source.id });
    case "server":
      return t("widget.type.server");
    case "agent_cpu":
      return t("widget.title.agent_cpu");
    default:
      return `${t(AGENT_TITLE[source.kind])}: ${source.key}`;
  }
}

export interface QueryResult {
  query: ChartQuery;
  data: Series | undefined;
  isError: boolean;
  error: unknown;
}

/** Dane wszystkich zapytań wykresu z własnym zakresem i odświeżaniem widgetu (puste = ustawienia globalne). */
export function useChartQueries(config: ChartConfig) {
  const global = useRefresh();
  const minutes = config.range_min ?? global.rangeMinutes;
  const own = config.refresh_s;
  const refetchInterval = own == null ? global.refetchInterval : own > 0 ? own * 1000 : false;
  const results = useQueries({
    queries: config.queries.map((q) => ({
      queryKey: ["chart", q.source, minutes, q.offset_min ?? 0],
      queryFn: () => fetchSeries(q.source, minutes, q.offset_min ?? 0),
      refetchInterval,
      placeholderData: (previous: Series | undefined) => previous, // przy zmianie zakresu stary wykres zostaje do czasu nowych danych
      retry: false,
    })),
  });
  const queries: QueryResult[] = config.queries.map((query, i) => ({
    query,
    data: results[i]?.data,
    isError: results[i]?.isError ?? false,
    error: results[i]?.error,
  }));
  return {
    queries,
    minutes,
    isLoading: results.some((r) => r.isLoading),
    // Błąd wykresu tylko wtedy, gdy żadne zapytanie nie dało danych (jedno brakujące źródło nie gasi reszty)
    isError: results.length > 0 && results.every((r) => r.isError && !r.data),
    error: results.find((r) => r.error)?.error,
  };
}
