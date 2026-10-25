/** Strona klienta sieci: szczegóły, obecność i historia połączeń (API: backend/netpulse/api/clients.py). */
import { useQuery } from "@tanstack/react-query";
import { get } from "./api";
import { useRefresh } from "./refresh";
import type { NetworkClient } from "./unifi";

export interface ClientDetail {
  mac: string;
  name: string | null;
  ip: string | null;
  is_wired: boolean;
  is_guest: boolean;
  online: boolean;
  first_seen_at: string;
  last_seen_at: string;
  /** Stan z ostatniego odczytu kontrolera; null, gdy klienta teraz nie ma w sieci */
  current: NetworkClient | null;
}

export interface Presence {
  interval_s: number;
  /** Ile próbek w kubełku oznacza obecność przez cały kubełek */
  expected: number;
  buckets: { time: string; samples: number }[];
}

export interface ClientEvent {
  time: string;
  kind: "connect" | "roam" | "band";
  uplink_device_id: number | null;
  uplink_name: string | null;
  uplink_port: number | null;
  essid: string | null;
  radio: string | null;
  /** Dla „connect” po przerwie: jak długo klienta nie było (s) */
  gap_s: number | null;
}

// MAC (02:00:00:00:00:01) może stać w ścieżce wprost – dwukropek jest dozwolony w adresie
const path = (mac: string) => `/api/clients/${mac}`;
export const clientUrl = (mac: string) => `/clients/${mac}`;

export function useClient(mac: string) {
  const { refetchInterval } = useRefresh();
  return useQuery({ queryKey: ["client", mac], queryFn: () => get<ClientDetail>(path(mac)), refetchInterval, retry: false });
}

export function useClientPresence(mac: string, minutes: number) {
  const { refetchInterval } = useRefresh();
  return useQuery({
    queryKey: ["client-presence", mac, minutes],
    queryFn: () => get<Presence>(`${path(mac)}/presence?minutes=${minutes}`),
    refetchInterval,
    placeholderData: (previous) => previous,
  });
}

export function useClientEvents(mac: string, minutes: number) {
  const { refetchInterval } = useRefresh();
  return useQuery({
    queryKey: ["client-events", mac, minutes],
    queryFn: () => get<ClientEvent[]>(`${path(mac)}/events?minutes=${minutes}`),
    refetchInterval,
  });
}

export const clientMetricsPath = (mac: string, minutes: number) => `${path(mac)}/metrics?minutes=${minutes}`;

// Kubełki API są wyrównane do 2000-01-01 00:00 UTC (date_bin)
const ORIGIN = Date.UTC(2000, 0, 1);

/** Pełna oś obecności od początku zakresu do teraz: udział czasu w sieci (0–1) w każdym kubełku. */
export function presenceTimeline(p: Presence, minutes: number, now = Date.now()): { start: number; share: number }[] {
  const stride = p.interval_s * 1000;
  const bySlot = new Map(p.buckets.map((b) => [new Date(b.time).getTime(), b.samples]));
  const first = Math.floor((now - minutes * 60_000 - ORIGIN) / stride) * stride + ORIGIN;
  const out: { start: number; share: number }[] = [];
  for (let start = first; start <= now; start += stride) {
    const samples = bySlot.get(start) ?? 0;
    out.push({ start, share: p.expected > 0 ? Math.min(1, samples / p.expected) : samples > 0 ? 1 : 0 });
  }
  return out;
}

/** Pasmo WiFi słownie: „5 GHz”, „2,4 GHz”, „6 GHz”. */
export function radioLabel(radio: string | null): string | null {
  if (!radio) return null;
  if (radio === "na") return "5 GHz";
  if (radio === "ng") return "2,4 GHz";
  if (radio === "6e") return "6 GHz";
  return radio;
}
