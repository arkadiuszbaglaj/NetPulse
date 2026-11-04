/** VPN użytkowników zdalnych z bramy UniFi (od 0.57.0, moduł UniFi): kto jest połączony, od kiedy, ruch.
 * API: backend/netpulse/api/vpn.py; opis: docs/30-vpn.md. */
import { useQuery } from "@tanstack/react-query";
import { get } from "./api";

export interface VpnServer {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  port: number | null;
  subnet: string | null;
}

export interface VpnUser {
  name: string;
  server: string | null;
  tunnel_ip: string | null;
  connected: boolean;
  since: string | null;
  last_seen: string | null;
  remote_ip: string | null;
  down_bytes: number | null;
  up_bytes: number | null;
  down_bps: number | null;
  up_bps: number | null;
}

export interface VpnStatus {
  at: string | null;
  stale: boolean;
  device_id: number | null;
  servers: VpnServer[];
  users: VpnUser[];
}

export const VPN_KEY = ["vpn"];

export function useVpn(refetchInterval: number | false) {
  return useQuery({ queryKey: VPN_KEY, queryFn: () => get<VpnStatus>("/api/vpn"), refetchInterval, retry: false });
}
