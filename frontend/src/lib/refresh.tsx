/**
 * Globalne ustawienia odświeżania danych: jak często panel pyta API i jaki zakres czasu pokazują wykresy.
 * Na razie zapamiętywane w przeglądarce; zapis na koncie użytkownika dochodzi razem z personalizacją (etap 5e).
 */
import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

/** Dostępne interwały odświeżania w sekundach; 0 = wyłączone (tylko ręcznie). */
export const REFRESH_OPTIONS = [0, 5, 10, 30, 60, 300] as const;
export type RefreshSeconds = (typeof REFRESH_OPTIONS)[number];
export const DEFAULT_REFRESH: RefreshSeconds = 30;

/** Dostępne zakresy czasu wykresów w minutach. */
export const RANGE_OPTIONS = [15, 60, 360, 1440, 10080] as const;
export type RangeMinutes = (typeof RANGE_OPTIONS)[number];
export const DEFAULT_RANGE: RangeMinutes = 60;

const REFRESH_KEY = "netpulse.refresh";
const RANGE_KEY = "netpulse.range";

function readChoice<T extends number>(key: string, options: readonly T[], fallback: T): T {
  try {
    const n = Number(localStorage.getItem(key));
    const found = options.find((o) => o === n);
    if (localStorage.getItem(key) !== null && found !== undefined) return found;
  } catch {
    /* localStorage może być zablokowany */
  }
  return fallback;
}

function store(key: string, value: number) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* bez zapamiętywania */
  }
}

interface RefreshContextValue {
  refreshSeconds: RefreshSeconds;
  setRefreshSeconds: (s: RefreshSeconds) => void;
  /** Wartość dla `refetchInterval` w TanStack Query (false = bez automatycznego odświeżania). */
  refetchInterval: number | false;
  rangeMinutes: RangeMinutes;
  setRangeMinutes: (m: RangeMinutes) => void;
  /** Odśwież teraz wszystkie dane z API (poza stanem logowania). */
  refreshNow: () => void;
  /** Czy trwa pobieranie danych (do animacji przycisku). */
  isRefreshing: boolean;
}

const RefreshContext = createContext<RefreshContextValue | null>(null);

export function RefreshProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [refreshSeconds, setRefreshState] = useState<RefreshSeconds>(() =>
    readChoice(REFRESH_KEY, REFRESH_OPTIONS, DEFAULT_REFRESH),
  );
  const [rangeMinutes, setRangeState] = useState<RangeMinutes>(() => readChoice(RANGE_KEY, RANGE_OPTIONS, DEFAULT_RANGE));
  const fetching = useIsFetching({ predicate: (q) => q.queryKey[0] !== "auth" });

  const setRefreshSeconds = useCallback((s: RefreshSeconds) => {
    store(REFRESH_KEY, s);
    setRefreshState(s);
  }, []);
  const setRangeMinutes = useCallback((m: RangeMinutes) => {
    store(RANGE_KEY, m);
    setRangeState(m);
  }, []);
  const refreshNow = useCallback(() => {
    void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "auth" });
  }, [qc]);

  const value = useMemo<RefreshContextValue>(
    () => ({
      refreshSeconds,
      setRefreshSeconds,
      refetchInterval: refreshSeconds > 0 ? refreshSeconds * 1000 : false,
      rangeMinutes,
      setRangeMinutes,
      refreshNow,
      isRefreshing: fetching > 0,
    }),
    [refreshSeconds, setRefreshSeconds, rangeMinutes, setRangeMinutes, refreshNow, fetching],
  );
  return <RefreshContext.Provider value={value}>{children}</RefreshContext.Provider>;
}

export function useRefresh(): RefreshContextValue {
  const ctx = useContext(RefreshContext);
  if (!ctx) throw new Error("useRefresh poza RefreshProvider");
  return ctx;
}
