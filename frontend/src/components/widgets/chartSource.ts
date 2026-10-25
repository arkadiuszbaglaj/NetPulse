/** Skąd bierze dane wykres: ścieżki API dla każdego rodzaju źródła i normalizacja odpowiedzi. */
import { useQuery } from "@tanstack/react-query";
import { t } from "../../i18n";
import { get, type Series, type SeriesPoint } from "../../lib/api";
import type { ChartConfig, Source } from "../../lib/layout";
import { useRefresh } from "../../lib/refresh";

/** Ten sam rozmiar kubełka co w API: ~300 punktów, nie mniej niż 30 s. */
export const bucketSeconds = (minutes: number) => Math.max(30, Math.floor((minutes * 60) / 300));

export function sourcePath(source: Source, minutes: number): string {
  switch (source.kind) {
    case "wan":
      return `/api/dashboard/traffic?minutes=${minutes}`;
    case "wifi_total":
      return `/api/dashboard/wifi?minutes=${minutes}`;
    case "interface":
      return `/api/interfaces/${source.id}/metrics?minutes=${minutes}`;
    case "device":
      return `/api/devices/${source.id}/metrics?minutes=${minutes}`;
    case "wifi_network":
      return `/api/wifi/${source.id}/metrics?minutes=${minutes}`;
    case "server":
      return `/api/system/metrics?minutes=${minutes}`;
    default:
      return `/api/devices/${source.id}/agent-metrics?source=${source.kind}&key=${encodeURIComponent(source.key)}&minutes=${minutes}`;
  }
}

const AGENT_TITLE = {
  agent_net: "ce.source.agent_net",
  agent_disk: "ce.source.agent_disk",
  agent_temp: "ce.source.agent_temp",
  agent_container: "ce.source.agent_container",
  pve_guest: "ce.source.pve_guest",
} as const;

/** Endpointy pulpitu zwracają `{interval_s, points}`, pozostałe samą listę punktów. */
export async function fetchSeries(source: Source, minutes: number): Promise<Series> {
  const raw = await get<Series | SeriesPoint[]>(sourcePath(source, minutes));
  return Array.isArray(raw) ? { interval_s: bucketSeconds(minutes), points: raw } : raw;
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

/** Dane wykresu z własnym zakresem i odświeżaniem widgetu (puste = ustawienia globalne). */
export function useChartSeries(config: ChartConfig) {
  const global = useRefresh();
  const minutes = config.range_min ?? global.rangeMinutes;
  const own = config.refresh_s;
  const refetchInterval = own == null ? global.refetchInterval : own > 0 ? own * 1000 : false;
  const query = useQuery({
    queryKey: ["chart", config.source, minutes],
    queryFn: () => fetchSeries(config.source, minutes),
    refetchInterval,
    placeholderData: (previous) => previous, // przy zmianie zakresu stary wykres zostaje do czasu nowych danych
    retry: false,
  });
  return { ...query, minutes };
}
