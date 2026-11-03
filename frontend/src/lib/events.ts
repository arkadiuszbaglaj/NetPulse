/** Zdarzenia: restarty urządzeń i przełączenia WAN – kafelek „Zdarzenia” (na wykresach nie są rysowane). API: api/events.py. */
import { useQuery } from "@tanstack/react-query";
import { get } from "./api";

export type EventKind = "restart" | "wan_switch";

export interface ChartEvent {
  time: string;
  kind: EventKind;
  title: string;
  device_id: number | null;
}

/** Zdarzenia z ostatnich `minutes` minut (`back` – okno przesunięte wstecz); `enabled` – nie na pulpicie publicznym. */
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
