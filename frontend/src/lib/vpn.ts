/** VPN użytkowników zdalnych z bramy UniFi (od 0.57.0, moduł UniFi): kto jest połączony, od kiedy, ruch.
 * API: backend/netpulse/api/vpn.py; opis: docs/30-vpn.md. */
import { useQuery } from "@tanstack/react-query";
import { get } from "./api";
import type { LiveVpn } from "./liveHub";

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

/** Stan VPN z odczytem na żywo (od 0.72.0): kanał na żywo (co ~1,5 s z kontrolera) jest ważniejszy od zapisu kolektora
 * (co 30 s) – połączeni teraz, ich ruch i bajty; kto był połączony, a w świeżej próbce go nie ma, właśnie się rozłączył.
 * Klient, którego jeszcze nie ma na liście (pierwsze połączenie), pojawia się od razu. Kolejność jak w API. */
export function withLiveVpn(status: VpnStatus, live: LiveVpn | null): VpnStatus {
  if (!live) return status;
  const now = new Map(live.users.map((u) => [u.name, u]));
  const users: VpnUser[] = status.users.map((u) => {
    const l = now.get(u.name);
    if (l) return { ...u, connected: true, since: l.since ?? u.since, remote_ip: l.remote_ip ?? u.remote_ip, tunnel_ip: l.tunnel_ip ?? u.tunnel_ip, down_bps: l.down_bps, up_bps: l.up_bps, down_bytes: l.down_bytes ?? u.down_bytes, up_bytes: l.up_bytes ?? u.up_bytes, last_seen: live.time };
    return u.connected ? { ...u, connected: false, since: null, down_bps: null, up_bps: null, last_seen: live.time } : u;
  });
  const known = new Set(status.users.map((u) => u.name));
  for (const l of live.users) {
    if (!known.has(l.name)) users.push({ ...l, server: null, connected: true, last_seen: live.time });
  }
  const ms = (s: string | null) => (s ? Date.parse(s) : 0);
  users.sort((a, b) => Number(b.connected) - Number(a.connected) || (a.connected ? ms(a.since) - ms(b.since) : ms(b.last_seen) - ms(a.last_seen)) || a.name.localeCompare(b.name));
  return { ...status, users, stale: false, at: live.time };
}
