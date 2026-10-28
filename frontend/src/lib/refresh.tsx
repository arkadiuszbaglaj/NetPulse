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

/** Dostępne zakresy czasu wykresów w minutach (30 dni i rok – z agregatów godzinowych w bazie). */
export const RANGE_OPTIONS = [15, 60, 360, 1440, 10080, 43200, 525600] as const;
export type RangeMinutes = (typeof RANGE_OPTIONS)[number];
export const DEFAULT_RANGE: RangeMinutes = 60;

/** Powiększony fragment osi czasu (zaznaczenie myszą na wykresie): czasy w ms i okno zapytań do API –
 * `minutes` wstecz od chwili `offset` minut temu. Powiększenie zatrzymuje automatyczne odświeżanie wykresów. */
export interface Zoom {
  from: number;
  to: number;
  minutes: number;
  offset: number;
}

/** Okno API dla fragmentu [from, to]: przesunięcie w pełnych minutach (w dół), zakres co najmniej 5 minut (limit API). */
export function zoomWindow(from: number, to: number, now = Date.now()): Zoom {
  const offset = Math.max(0, Math.floor((now - to) / 60_000));
  const until = now - offset * 60_000;
  return { from, to, offset, minutes: Math.max(5, Math.ceil((until - from) / 60_000)) };
}

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
  /** Powiększenie wykresów (null = cały zakres); kolejne powiększenia odkładają się na stos – „Wróć” cofa o jedno. */
  zoom: Zoom | null;
  /** Czy wolno powiększać (nie na pulpicie publicznym, gdzie API przyjmuje tylko zakresy z pulpitu) */
  canZoom: boolean;
  zoomTo: (from: number, to: number) => void;
  zoomOut: () => void;
  clearZoom: () => void;
  /** Odśwież teraz wszystkie dane z API (poza stanem logowania). */
  refreshNow: () => void;
  /** Czy trwa pobieranie danych (do animacji przycisku). */
  isRefreshing: boolean;
}

const RefreshContext = createContext<RefreshContextValue | null>(null);

/** `fixed` – stałe ustawienia (pulpit publiczny): bez wyboru i bez zapamiętywania w przeglądarce. */
export function RefreshProvider({ children, fixed }: { children: ReactNode; fixed?: { refreshSeconds: RefreshSeconds; rangeMinutes: RangeMinutes } }) {
  const qc = useQueryClient();
  const [ownRefresh, setRefreshState] = useState<RefreshSeconds>(() => readChoice(REFRESH_KEY, REFRESH_OPTIONS, DEFAULT_REFRESH));
  const [ownRange, setRangeState] = useState<RangeMinutes>(() => readChoice(RANGE_KEY, RANGE_OPTIONS, DEFAULT_RANGE));
  const refreshSeconds = fixed?.refreshSeconds ?? ownRefresh;
  const rangeMinutes = fixed?.rangeMinutes ?? ownRange;
  const fetching = useIsFetching({ predicate: (q) => q.queryKey[0] !== "auth" });
  const isFixed = fixed !== undefined;
  const [zooms, setZooms] = useState<Zoom[]>([]);
  const zoomTo = useCallback(
    (from: number, to: number) => {
      if (!isFixed && to > from) setZooms((z) => [...z, zoomWindow(from, to)]);
    },
    [isFixed],
  );
  const zoomOut = useCallback(() => setZooms((z) => z.slice(0, -1)), []);
  const clearZoom = useCallback(() => setZooms((z) => (z.length ? [] : z)), []);

  const setRefreshSeconds = useCallback(
    (s: RefreshSeconds) => {
      if (isFixed) return;
      store(REFRESH_KEY, s);
      setRefreshState(s);
    },
    [isFixed],
  );
  const setRangeMinutes = useCallback(
    (m: RangeMinutes) => {
      if (isFixed) return;
      store(RANGE_KEY, m);
      setRangeState(m);
      setZooms([]);
    },
    [isFixed],
  );
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
      zoom: zooms.at(-1) ?? null,
      canZoom: !isFixed,
      zoomTo,
      zoomOut,
      clearZoom,
      refreshNow,
      isRefreshing: fetching > 0,
    }),
    [refreshSeconds, setRefreshSeconds, rangeMinutes, setRangeMinutes, zooms, isFixed, zoomTo, zoomOut, clearZoom, refreshNow, fetching],
  );
  return <RefreshContext.Provider value={value}>{children}</RefreshContext.Provider>;
}

export function useRefresh(): RefreshContextValue {
  const ctx = useContext(RefreshContext);
  if (!ctx) throw new Error("useRefresh poza RefreshProvider");
  return ctx;
}
