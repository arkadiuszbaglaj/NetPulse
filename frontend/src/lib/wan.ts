/** Łącza WAN routera – dual WAN / failover (API: backend/netpulse/api/wan.py). */
import { useQuery } from "@tanstack/react-query";
import { get, type SeriesPoint } from "./api";
import { useRefresh } from "./refresh";

/** active – ruch idzie tym łączem; standby – sprawne, bez ruchu (zapas); down – nie działa; unknown – brak danych. */
export type WanState = "active" | "standby" | "down" | "unknown";

export interface WanLink {
  id: number;
  name: string;
  position: number;
  device_id: number;
  device_name: string;
  interface_id: number;
  interface_name: string;
  interface_label: string;
  speed_mbps: number | null;
  state: WanState;
  state_since: string | null;
  source: "controller" | "traffic" | null;
  in_bps: number | null;
  out_bps: number | null;
  sampled_at: string | null;
}

export interface WanStatus {
  links: WanLink[];
  active_ids: number[];
}

export interface WanSegment {
  link_id: number;
  state: Exclude<WanState, "unknown">;
  start: string;
  end: string;
}

export interface WanSwitch {
  time: string;
  from_ids: number[];
  to_ids: number[];
}

export interface WanHistory {
  interval_s: number;
  links: WanLink[];
  /** Wartości `in_<id>` / `out_<id>`: ruch łącza tylko wtedy, gdy było aktywne */
  points: SeriesPoint[];
  segments: WanSegment[];
  switches: WanSwitch[];
}

export interface WanOutage {
  start: string;
  end: string;
  duration_s: number;
  ongoing: boolean;
}

export interface WanLinkSla {
  link: WanLink;
  availability: number | null;
  up_s: number;
  down_s: number;
  active_s: number;
  unknown_s: number;
  outages: number;
  longest_outage_s: number;
  recent_outages: WanOutage[];
}

export interface WanSla {
  days: number;
  start: string;
  end: string;
  links: WanLinkSla[];
}

export type SlaDays = 1 | 7 | 30;
export const SLA_DAYS: SlaDays[] = [1, 7, 30];

export const WAN_LINKS_KEY = ["wan", "links"] as const;

export function useWanStatus() {
  const { refetchInterval } = useRefresh();
  return useQuery({ queryKey: ["wan", "status"], queryFn: () => get<WanStatus>("/api/wan/status"), refetchInterval });
}

export function useWanHistory(minutes: number) {
  const { refetchInterval } = useRefresh();
  return useQuery({
    queryKey: ["wan", "history", minutes],
    queryFn: () => get<WanHistory>(`/api/wan/history?minutes=${minutes}`),
    refetchInterval,
    placeholderData: (previous) => previous,
  });
}

export function useWanSla(days: SlaDays) {
  const { refetchInterval } = useRefresh();
  return useQuery({
    queryKey: ["wan", "sla", days],
    queryFn: () => get<WanSla>(`/api/wan/sla?days=${days}`),
    // SLA za dni nie zmienia się co kilka sekund – najwyżej co minutę
    refetchInterval: refetchInterval === false ? false : Math.max(60_000, refetchInterval),
  });
}

export function useWanLinks() {
  return useQuery({ queryKey: WAN_LINKS_KEY, queryFn: () => get<WanLink[]>("/api/wan/links") });
}

/** Łącza wybranego routera (puste = wszystkie). */
export const forDevice = <T extends { device_id: number }>(items: T[], deviceId?: number | null): T[] =>
  deviceId == null ? items : items.filter((x) => x.device_id === deviceId);

/** Czas trwania: „45 s”, „12 min”, „3 h 5 min”, „2 d 4 h”. */
export function formatDuration(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return h > 0 ? `${d} d ${h} h` : `${d} d`;
  if (h > 0) return m > 0 ? `${h} h ${m} min` : `${h} h`;
  return `${m} min`;
}

/** Dostępność w %: „99,95%”; 100 bez miejsc po przecinku, brak danych → „–”. */
export function formatAvailability(pct: number | null): string {
  if (pct == null) return "–";
  if (pct >= 100) return "100%";
  // Nie zaokrąglamy w górę do 100% – to by ukryło przerwę
  const floored = Math.floor(pct * 100) / 100;
  return `${new Intl.NumberFormat("pl", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(floored)}%`;
}

/** Ocena dostępności: od 99,9% dobra, od 99% słabsza, poniżej – zła. */
export function availabilityTone(pct: number | null): "ok" | "warn" | "danger" | "none" {
  if (pct == null) return "none";
  if (pct >= 99.9) return "ok";
  if (pct >= 99) return "warn";
  return "danger";
}
