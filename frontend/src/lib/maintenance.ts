/** Okna serwisowe (od 0.60.0): planowane prace bez powiadomień, czas okna nie liczy się do dostępności. */
import { useQuery } from "@tanstack/react-query";
import { get } from "./api";
import { useRefresh } from "./refresh";

export type WindowKind = "once" | "weekly";

export interface MaintenanceWindow {
  id: number;
  name: string;
  enabled: boolean;
  /** Puste = wszystkie urządzenia, sprawdzenia i alerty bez urządzenia */
  device_ids: number[];
  kind: WindowKind;
  starts_at: string | null;
  ends_at: string | null;
  /** 0 = poniedziałek … 6 = niedziela */
  days: number[];
  /** "GG:MM" w strefie czasowej serwera */
  time_from: string | null;
  duration_min: number | null;
  note: string | null;
  created_at: string;
  active: boolean;
  active_until: string | null;
  next_start: string | null;
}

export type MaintenanceWindowIn = Omit<MaintenanceWindow, "id" | "created_at" | "active" | "active_until" | "next_start">;

export const MAINTENANCE_KEY = ["maintenance"] as const;

export function useMaintenance() {
  const { refetchInterval } = useRefresh();
  return useQuery({ queryKey: MAINTENANCE_KEY, queryFn: () => get<MaintenanceWindow[]>("/api/maintenance"), refetchInterval });
}

/** Wartość pola datetime-local (czas przeglądarki) z ISO i odwrotnie. */
export function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Czas trwania w minutach jako „2 h 30 min”. */
export function formatMinutes(min: number): string {
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  return [d && `${d} d`, h && `${h} h`, m && `${m} min`].filter(Boolean).join(" ") || "0 min";
}
