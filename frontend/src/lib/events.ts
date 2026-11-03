/** Zdarzenia na osi czasu wykresów (adnotacje): restarty urządzeń i przełączenia WAN (alertów na wykresach nie ma
 * – są na liście alertów i pod dzwonkiem). API: api/events.py. */
import { useQuery } from "@tanstack/react-query";
import { get } from "./api";
import { isAgentSource, type Annotations, type ChartConfig } from "./layout";
import { useRefresh } from "./refresh";

export type EventKind = "restart" | "wan_switch";

export interface ChartEvent {
  time: string;
  kind: EventKind;
  title: string;
  device_id: number | null;
}

/** Zdarzenia z okna wykresu (zakres albo powiększony fragment); `enabled` – nie na pulpicie publicznym. */
export function useEvents(minutes: number, back: number, refetchInterval: number | false, enabled: boolean) {
  return useQuery({
    queryKey: ["events", minutes, back],
    queryFn: () => get<ChartEvent[]>(`/api/events?minutes=${minutes}${back ? `&offset=${back}` : ""}`),
    refetchInterval,
    enabled,
    placeholderData: (previous) => previous,
    retry: false,
  });
}

/** Zdarzenia dla wykresu. „auto”: wykres urządzenia, portu albo z agenta – zdarzenia tych urządzeń;
 * wykres ogólny (WAN, WiFi, serwer NetPulse, sprawdzenie) – przełączenia WAN. */
export function eventsFor(events: ChartEvent[], config: ChartConfig, mode: Annotations = config.annotations ?? "auto"): ChartEvent[] {
  if (mode === "off") return [];
  if (mode === "all") return events;
  const devices = new Set<number>();
  for (const { source } of config.queries) {
    if (source.kind === "device" || isAgentSource(source.kind)) devices.add((source as { id: number }).id);
    if (source.kind === "interface" && source.device_id) devices.add(source.device_id);
  }
  if (devices.size === 0) return events.filter((e) => e.kind === "wan_switch");
  return events.filter((e) => e.device_id != null && devices.has(e.device_id));
}

/** Wykres pokazuje zdarzenia z okna: ten sam zakres i odświeżanie co dane wykresu. */
export function useChartEvents(config: ChartConfig, enabled: boolean): ChartEvent[] {
  const global = useRefresh();
  const zoom = global.zoom;
  const minutes = zoom?.minutes ?? config.range_min ?? global.rangeMinutes;
  const mode = config.annotations ?? "auto";
  const query = useEvents(minutes, zoom?.offset ?? 0, zoom ? false : global.refetchInterval, enabled && mode !== "off");
  return query.data ? eventsFor(query.data, config, mode) : [];
}
