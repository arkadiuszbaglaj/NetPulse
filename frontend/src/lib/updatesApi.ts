/** Aktualizacje: stan z API (wspólny dla strony Ustawienia → Aktualizacja i plakietki w pasku górnym). */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { get, request, type UpdateSettings, type UpdatesResponse } from "./api";

export const UPDATES_KEY = ["updates"] as const;
const SETTINGS_KEY = ["updates", "settings"] as const;
const POLL_MS = 2000; // podczas aktualizacji pytamy często, niezależnie od globalnego interwału odświeżania
const IDLE_POLL_MS = 10 * 60 * 1000; // poza nią wystarczy rzadko: serwer sam sprawdza wydania cyklicznie

export function useUpdates() {
  return useQuery({
    queryKey: UPDATES_KEY,
    queryFn: () => get<UpdatesResponse>("/api/updates"),
    refetchInterval: (query) => (query.state.data?.job?.state === "running" ? POLL_MS : IDLE_POLL_MS),
    retry: false,
  });
}

export function useUpdateSettings() {
  return useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: () => get<UpdateSettings>("/api/updates/settings"),
    retry: false,
  });
}

export function useSaveUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (settings: UpdateSettings) => request<UpdateSettings>("PUT", "/api/updates/settings", settings),
    onSuccess: (saved) => qc.setQueryData(SETTINGS_KEY, saved),
  });
}

/** Wersja, o której przypomina plakietka (null = nic do pokazania). */
/** Numer wersji tylko wtedy, gdy różni się od zainstalowanego (nowe zmiany mogą mieć ten sam numer). */
export function newerVersion(latest: string | null | undefined, installed: string | null | undefined): string | null {
  return latest && latest !== installed ? latest : null;
}

export function availableUpdate(data: UpdatesResponse | undefined): { id: string; version: string | null } | null {
  const info = data?.info;
  if (!data?.updater.reachable || !info?.update_available || info.diverged) return null;
  return { id: info.latest.commit ?? info.latest.version ?? "?", version: newerVersion(info.latest.version, data.installed_version) };
}
