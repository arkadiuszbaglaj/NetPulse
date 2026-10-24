/** Układ pulpitu zapisany na koncie. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { del, get, request } from "./api";
import { DEFAULT_LAYOUT, type DashboardLayout, type DashboardResponse } from "./layout";

export const LAYOUT_KEY = ["dashboard-layout"] as const;

/** Zapisany układ albo układ domyślny (gdy użytkownik niczego nie zapisał). */
export function useDashboardLayout() {
  const query = useQuery({
    queryKey: LAYOUT_KEY,
    queryFn: () => get<DashboardResponse>("/api/dashboards/default"),
    retry: false,
  });
  const layout: DashboardLayout = query.data?.layout ?? DEFAULT_LAYOUT;
  return { ...query, layout, isCustom: query.data?.layout != null };
}

export function useSaveLayout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (layout: DashboardLayout) => request<DashboardResponse>("PUT", "/api/dashboards/default", layout),
    onSuccess: (saved) => qc.setQueryData(LAYOUT_KEY, saved),
  });
}

export function useResetLayout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => del("/api/dashboards/default"),
    onSuccess: () => qc.setQueryData(LAYOUT_KEY, { layout: null, updated_at: null } satisfies DashboardResponse),
  });
}
