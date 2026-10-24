/** Zapytania do API z wspólnym odświeżaniem (interwał i zakres czasu z `useRefresh`). */
import { useQuery } from "@tanstack/react-query";
import { get, type DashboardSummary, type Device, type Series } from "./api";
import { useRefresh } from "./refresh";

export function useDashboardSummary() {
  const { refetchInterval } = useRefresh();
  return useQuery({
    queryKey: ["dashboard", "summary"],
    queryFn: () => get<DashboardSummary>("/api/dashboard/summary"),
    refetchInterval,
  });
}

export function useDevices() {
  const { refetchInterval } = useRefresh();
  return useQuery({
    queryKey: ["devices"],
    queryFn: () => get<Device[]>("/api/devices"),
    refetchInterval,
  });
}

export function useSeries(kind: "traffic" | "wifi") {
  const { refetchInterval, rangeMinutes } = useRefresh();
  return useQuery({
    queryKey: ["dashboard", kind, rangeMinutes],
    queryFn: () => get<Series>(`/api/dashboard/${kind}?minutes=${rangeMinutes}`),
    refetchInterval,
    // Przy zmianie zakresu stary wykres zostaje na ekranie do czasu nowych danych
    placeholderData: (previous) => previous,
  });
}
