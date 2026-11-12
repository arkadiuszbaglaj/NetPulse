import { IconMenu2, IconSearch, IconX } from "@tabler/icons-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import { t } from "../i18n";
import { useRefresh } from "../lib/refresh";
import { useVisibleModules } from "../modules";
import { AlertBell } from "./AlertBell";
import { LiveToggle } from "./LiveToggle";
import { RefreshControl } from "./RefreshControl";
import { Sidebar } from "./Sidebar";
import { ThemeToggle } from "./ThemeToggle";
import { UpdateBadge } from "./UpdateBadge";
import { UserMenu } from "./UserMenu";
import { Logo } from "./ui";

// Paleta poleceń (Ctrl+K) – osobny plik pobierany przy pierwszym otwarciu
const CommandPalette = lazy(() => import("./CommandPalette").then((m) => ({ default: m.CommandPalette })));
const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform ?? "");

const SIDEBAR_KEY = "netpulse.sidebar";

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === "collapsed";
  } catch {
    return false;
  }
}

/** Na czas pobierania pliku strony (pierwsze wejście w nią). */
function PageLoading() {
  return (
    <p role="status" className="py-10 text-center text-sm text-text-2">
      {t("app.loading")}
    </p>
  );
}

/** Układ aplikacji: menu po lewej na całą wysokość (z logo), nad treścią pasek z kontem, motywem i odświeżaniem. */
export function Shell() {
  const { status } = useAuth();
  // Trasy tylko dla włączonych modułów – adres wyłączonego modułu przekierowuje na pulpit
  const visible = useVisibleModules();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [drawer, setDrawer] = useState(false);
  const [palette, setPalette] = useState(false);
  const { pathname } = useLocation();
  const { clearZoom } = useRefresh();

  // Powiększenie wykresów dotyczy jednej strony – po przejściu dalej znów cały zakres
  useEffect(() => clearZoom(), [pathname, clearZoom]);

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_KEY, collapsed ? "collapsed" : "expanded");
    } catch {
      /* bez zapamiętywania */
    }
  }, [collapsed]);

  useEffect(() => {
    // Plik wykresów (ECharts, ~190 kB po kompresji) pobieramy w wolnej chwili zaraz po wejściu do panelu –
    // pierwszy wykres nie czeka wtedy na niego w kolejce za pulpitem i widgetem (od 0.67.0)
    const load = () => void import("./charts/PanelChart").catch(() => undefined);
    if (typeof requestIdleCallback === "function") {
      const id = requestIdleCallback(load, { timeout: 2000 });
      return () => cancelIdleCallback(id);
    }
    const id = setTimeout(load, 300);
    return () => clearTimeout(id);
  }, []);

  useEffect(() => {
    // Ctrl+K (⌘K) otwiera i zamyka paletę z każdego miejsca panelu, także z pola formularza
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((v) => !v);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setDrawer(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawer]);

  return (
    <div className="flex h-full">
      {drawer && <div className="fixed inset-0 z-20 bg-black/40 lg:hidden" onClick={() => setDrawer(false)} aria-hidden="true" />}
      <aside
        className={[
          "z-30 shrink-0 border-r border-border bg-bg transition-[width,transform] duration-200",
          "max-lg:fixed max-lg:inset-y-0 max-lg:left-0 max-lg:w-64",
          drawer ? "max-lg:translate-x-0" : "max-lg:-translate-x-full",
          collapsed ? "lg:w-[72px]" : "lg:w-60",
        ].join(" ")}
      >
        <Sidebar
          version={status?.version ?? undefined}
          collapsed={collapsed}
          onToggleCollapsed={() => setCollapsed((v) => !v)}
          onNavigate={() => setDrawer(false)}
        />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center justify-between gap-3 border-b border-border bg-surface px-3 sm:px-6 lg:border-transparent lg:bg-bg">
          <div className="flex items-center gap-2 lg:hidden">
            <button
              type="button"
              onClick={() => setDrawer((v) => !v)}
              aria-label={drawer ? t("nav.close") : t("nav.open")}
              aria-expanded={drawer}
              className="flex size-10 items-center justify-center rounded-lg text-text-2 hover:bg-surface-2"
            >
              {drawer ? <IconX size={20} aria-hidden="true" /> : <IconMenu2 size={20} aria-hidden="true" />}
            </button>
            <Logo size={28} />
            <span className="hidden text-base font-bold tracking-tight sm:inline">{t("app.name")}</span>
          </div>
          <button
            type="button"
            onClick={() => setPalette(true)}
            aria-label={t("palette.open")}
            title={t("palette.open")}
            className="flex h-9 items-center gap-2 rounded-lg px-2 text-sm text-muted hover:bg-surface-2 hover:text-text lg:w-64 lg:border lg:border-border lg:bg-surface lg:px-3"
          >
            <IconSearch size={18} aria-hidden="true" className="shrink-0" />
            <span className="hidden flex-1 text-left lg:block">{t("palette.button")}</span>
            <kbd className="hidden rounded-md border border-border px-1.5 py-0.5 text-[11px] lg:block">{IS_MAC ? "⌘K" : "Ctrl K"}</kbd>
          </button>
          <div className="ml-auto flex items-center gap-1.5">
            <UpdateBadge />
            <AlertBell />
            <LiveToggle />
            <RefreshControl />
            <ThemeToggle />
            <UserMenu />
          </div>
        </header>

        {palette && (
          <Suspense fallback={null}>
            <CommandPalette onClose={() => setPalette(false)} />
          </Suspense>
        )}

        <main className="min-w-0 flex-1 overflow-y-auto px-4 pb-10 pt-2 sm:px-6 lg:px-8">
          <Suspense fallback={<PageLoading />}>
            <Routes>
              {visible.flatMap((m) => {
                if (m.children) {
                  return [
                    <Route key={m.id} path={m.path} element={<Navigate to={`${m.path}/${m.children[0].path}`} replace />} />,
                    ...m.children.map((c) => (
                      <Route key={`${m.id}/${c.path}`} path={`${m.path}/${c.path}`} element={c.element} />
                    )),
                  ];
                }
                return [<Route key={m.id} path={m.path} element={m.element} />];
              })}
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </main>
      </div>
    </div>
  );
}
