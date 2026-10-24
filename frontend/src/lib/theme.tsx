import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type ThemePref = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const KEY = "netpulse.theme";
const QUERY = "(prefers-color-scheme: dark)";

export function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* localStorage może być zablokowany */
  }
  return "system";
}

export function resolveTheme(pref: ThemePref): ResolvedTheme {
  if (pref === "system") return window.matchMedia?.(QUERY).matches ? "dark" : "light";
  return pref;
}

export function applyTheme(pref: ThemePref): ResolvedTheme {
  const resolved = resolveTheme(pref);
  document.documentElement.dataset.theme = resolved;
  return resolved;
}

const ORDER: ThemePref[] = ["system", "light", "dark"];

interface ThemeContextValue {
  pref: ThemePref;
  resolved: ResolvedTheme;
  setPref: (pref: ThemePref) => void;
  /** Kolejny motyw w kolejności: system → jasny → ciemny. */
  cycle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [pref, setPrefState] = useState<ThemePref>(readPref);
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(readPref()));

  useEffect(() => {
    setResolved(applyTheme(pref));
    if (pref !== "system") return;
    const mql = window.matchMedia?.(QUERY);
    if (!mql) return;
    const onChange = () => setResolved(applyTheme("system"));
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [pref]);

  const setPref = useCallback((next: ThemePref) => {
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* ignorujemy – motyw działa do końca sesji */
    }
    setPrefState(next);
  }, []);

  const cycle = useCallback(() => setPref(ORDER[(ORDER.indexOf(pref) + 1) % ORDER.length]), [pref, setPref]);

  const value = useMemo(() => ({ pref, resolved, setPref, cycle }), [pref, resolved, setPref, cycle]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme poza ThemeProvider");
  return ctx;
}
