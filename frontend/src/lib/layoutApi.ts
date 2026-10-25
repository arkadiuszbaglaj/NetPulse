/** Układ pulpitu zapisany na koncie: domyślny (pod „/”) albo wybrany pulpit (pod /dashboards/<id>). */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, del, get, patch, request } from "./api";
import { DEFAULT_LAYOUT, type DashboardLayout, type DashboardResponse } from "./layout";

export const LAYOUT_KEY = ["dashboard-layout"] as const;
const byIdKey = (id: number) => ["dashboard-by-id", id] as const;

/** Pulpit o podanym id (GET /api/dashboards/{id}) – nazwa i układ. */
interface DashboardById {
  id: number;
  name: string;
  layout: DashboardLayout | null;
  updated_at: string;
}

/** Zapisany układ albo układ domyślny (gdy użytkownik niczego nie zapisał). `id` – konkretny pulpit zamiast domyślnego. */
export function useDashboardLayout(id?: number) {
  const byDefault = useQuery({
    queryKey: LAYOUT_KEY,
    queryFn: () => get<DashboardResponse>("/api/dashboards/default"),
    retry: false,
    enabled: id === undefined,
  });
  const byId = useQuery({
    queryKey: byIdKey(id ?? 0),
    queryFn: () => get<DashboardById>(`/api/dashboards/${id}`),
    retry: false,
    enabled: id !== undefined,
  });
  if (id !== undefined) {
    const missing = byId.error instanceof ApiError && byId.error.status === 404;
    return { ...byId, layout: byId.data?.layout ?? { version: 1 as const, widgets: [] }, isCustom: true, name: byId.data?.name, missing };
  }
  const layout: DashboardLayout = byDefault.data?.layout ?? DEFAULT_LAYOUT;
  return { ...byDefault, layout, isCustom: byDefault.data?.layout != null, name: undefined, missing: false };
}

export function useSaveLayout(id?: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (layout: DashboardLayout) =>
      id === undefined
        ? request<DashboardResponse>("PUT", "/api/dashboards/default", layout)
        : patch<DashboardById>(`/api/dashboards/${id}`, { layout }),
    onSuccess: (saved) => {
      if (id === undefined) qc.setQueryData(LAYOUT_KEY, saved);
      else qc.setQueryData(byIdKey(id), saved);
      return qc.invalidateQueries({ queryKey: ["dashboards"] });
    },
  });
}

export function useResetLayout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => del("/api/dashboards/default"),
    onSuccess: () => {
      qc.setQueryData(LAYOUT_KEY, { layout: null, updated_at: null } satisfies DashboardResponse);
      return qc.invalidateQueries({ queryKey: ["dashboards"] });
    },
  });
}
