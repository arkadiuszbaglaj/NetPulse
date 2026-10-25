/** Kopie zapasowe bazy (API: backend/netpulse/api/backups.py, wykonuje je usługa updater). */
import { useQuery } from "@tanstack/react-query";
import { get } from "./api";

export type BackupKind = "update" | "manual" | "prerestore";

export interface Backup {
  name: string;
  kind: BackupKind;
  size_bytes: number;
  created_at: string;
}

export interface RestoreStatus {
  state: "idle" | "running" | "ok" | "failed";
  backup?: string | null;
  step?: string | null;
  safety?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  error?: string | null;
}

export interface BackupsResponse {
  backups: Backup[];
  restore: RestoreStatus;
}

export const BACKUPS_KEY = ["backups"];

export function useBackups() {
  return useQuery({ queryKey: BACKUPS_KEY, queryFn: () => get<BackupsResponse>("/api/backups"), retry: false });
}

export const downloadUrl = (name: string) => `/api/backups/${encodeURIComponent(name)}/download`;

/** Czy API odpowiada (w trakcie przywracania jest zatrzymane). */
export async function apiHealthy(): Promise<boolean> {
  try {
    const res = await fetch("/api/health", { cache: "no-store" });
    return res.ok;
  } catch {
    return false;
  }
}
