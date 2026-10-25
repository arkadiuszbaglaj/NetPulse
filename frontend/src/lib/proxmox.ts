/** Proxmox VE: serwery, maszyny VM/LXC i magazyny (API: backend/netpulse/api/proxmox.py). */
import { useQuery } from "@tanstack/react-query";
import { get } from "./api";
import { useRefresh } from "./refresh";

export interface ProxmoxServer {
  id: number;
  name: string;
  host: string;
  port: number;
  token_id: string;
  verify_tls: boolean;
  enabled: boolean;
  status: string;
  version: string | null;
  cluster_name: string | null;
  last_polled_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
  created_at: string;
}

export interface ProxmoxProbe {
  version: string | null;
  cluster: string | null;
  nodes: number;
  guests: number;
  storages: number;
}

export interface ProxmoxGuest {
  server_id: number;
  server: string;
  vmid: number;
  node: string;
  device_id: number | null;
  type: "qemu" | "lxc" | string;
  name: string;
  key: string;
  status: string;
  template: boolean;
  tags: string | null;
  cpus: number | null;
  cpu_percent: number | null;
  mem_used: number | null;
  mem_total: number | null;
  disk_used: number | null;
  disk_total: number | null;
  uptime_s: number | null;
  last_backup_at: string | null;
  updated_at: string;
}

export interface ProxmoxStorage {
  server_id: number;
  node: string;
  storage: string;
  type: string | null;
  shared: boolean;
  active: boolean;
  content: string | null;
  used_bytes: number | null;
  total_bytes: number | null;
  updated_at: string;
}

export const PROXMOX_SERVERS_KEY = ["proxmox", "servers"];

export function useProxmoxServers() {
  const { refetchInterval } = useRefresh();
  return useQuery({ queryKey: PROXMOX_SERVERS_KEY, queryFn: () => get<ProxmoxServer[]>("/api/proxmox/servers"), refetchInterval });
}

export function useProxmoxGuests() {
  const { refetchInterval } = useRefresh();
  return useQuery({ queryKey: ["proxmox", "guests"], queryFn: () => get<ProxmoxGuest[]>("/api/proxmox/guests"), refetchInterval });
}

export function useProxmoxStorages() {
  const { refetchInterval } = useRefresh();
  return useQuery({ queryKey: ["proxmox", "storages"], queryFn: () => get<ProxmoxStorage[]>("/api/proxmox/storages"), refetchInterval });
}

/** Kopia starsza niż tyle godzin jest wyróżniana (zgodnie z domyślną regułą alertu). */
export const BACKUP_STALE_H = 36;

export function backupAgeHours(iso: string | null, now: number = Date.now()): number | null {
  return iso ? (now - new Date(iso).getTime()) / 3_600_000 : null;
}
