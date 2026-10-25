/** Kontrolery UniFi, klienci sieci i PoE (API: backend/netpulse/api/controllers.py). */
import { useQuery } from "@tanstack/react-query";
import { get } from "./api";
import { useRefresh } from "./refresh";

export interface Controller {
  id: number;
  name: string;
  host: string;
  port: number;
  site: string;
  verify_tls: boolean;
  enabled: boolean;
  app_version: string | null;
  status: string;
  last_polled_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
  created_at: string;
}

export interface ControllerProbe {
  app_version: string | null;
  devices: number;
  clients: number;
}

export interface NetworkClient {
  mac: string;
  name: string | null;
  ip: string | null;
  is_wired: boolean;
  is_guest: boolean;
  essid: string | null;
  radio: string | null;
  signal_dbm: number | null;
  tx_rate_kbps: number | null;
  rx_rate_kbps: number | null;
  uplink_device_id: number | null;
  uplink_name: string | null;
  uplink_port: number | null;
  connected_s: number | null;
  updated_at: string;
}

export interface PoePort {
  port_idx: number;
  label: string | null;
  power_w: number | null;
  voltage_v: number | null;
  current_ma: number | null;
  mode: string | null;
  poe_class: string | null;
  delivering: boolean | null;
}

export interface PoeInfo {
  budget: { used_w: number | null; max_w: number | null } | null;
  ports: PoePort[];
}

export const CONTROLLERS_KEY = ["controllers"] as const;

export function useControllers() {
  const { refetchInterval } = useRefresh();
  return useQuery({ queryKey: CONTROLLERS_KEY, queryFn: () => get<Controller[]>("/api/controllers"), refetchInterval });
}

export function useClients(kind?: "wifi" | "wired") {
  const { refetchInterval } = useRefresh();
  return useQuery({
    queryKey: ["clients", kind ?? "all"],
    queryFn: () => get<NetworkClient[]>(`/api/clients${kind ? `?kind=${kind}` : ""}`),
    refetchInterval,
  });
}

export function usePoe(deviceId: number | null) {
  const { refetchInterval } = useRefresh();
  return useQuery({
    queryKey: ["poe", deviceId],
    queryFn: () => get<PoeInfo>(`/api/devices/${deviceId}/poe`),
    enabled: deviceId != null,
    refetchInterval,
  });
}

/** Siła sygnału WiFi w słowach (progi jak w UniFi: od −50 dBm bardzo dobry, poniżej −75 słaby). */
export function signalQuality(dbm: number | null): "great" | "good" | "fair" | "weak" | null {
  if (dbm == null) return null;
  if (dbm >= -50) return "great";
  if (dbm >= -65) return "good";
  if (dbm >= -75) return "fair";
  return "weak";
}

/** Prędkość łącza z kb/s, np. 866000 → „866 Mb/s”. */
export function formatLinkRate(kbps: number | null): string {
  if (kbps == null) return "–";
  return kbps >= 1000 ? `${new Intl.NumberFormat("pl", { maximumFractionDigits: 0 }).format(kbps / 1000)} Mb/s` : `${kbps} kb/s`;
}

export function formatWatts(w: number | null | undefined): string {
  return w == null ? "–" : `${new Intl.NumberFormat("pl", { maximumFractionDigits: 1 }).format(w)} W`;
}
