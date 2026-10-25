/** Stan serwera NetPulse (API: backend/netpulse/api/system.py). */
import { useQuery } from "@tanstack/react-query";
import { get } from "./api";
import { useRefresh } from "./refresh";

export interface SystemInfo {
  sampled_at: string;
  cpu_percent: number | null;
  load1: number | null;
  load5: number | null;
  load15: number | null;
  mem_used_percent: number | null;
  mem_total_bytes: number | null;
  swap_used_percent: number | null;
  disk_used_percent: number | null;
  disk_free_bytes: number | null;
  disk_total_bytes: number | null;
  uptime_s: number | null;
  temp_c: number | null;
  db_size_bytes: number | null;
  poll_interval_s: number;
}

/** Ostatnia próbka albo null, gdy kolektor jeszcze żadnej nie zapisał. */
export function useSystem() {
  const { refetchInterval } = useRefresh();
  return useQuery({
    queryKey: ["system"],
    queryFn: () => get<SystemInfo | null>("/api/system"),
    refetchInterval,
  });
}

/** Poziom zajętości do koloru paska: od 85% ostrzeżenie, od 95% błąd. */
export function usageTone(percent: number | null): "ok" | "warn" | "danger" {
  if (percent == null) return "ok";
  return percent >= 95 ? "danger" : percent >= 85 ? "warn" : "ok";
}
