import { IconMenu2, IconX } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import { t } from "../i18n";
import { modules } from "../modules";
import { RefreshControl } from "./RefreshControl";
import { Sidebar } from "./Sidebar";
import { ThemeToggle } from "./ThemeToggle";
import { UpdateBadge } from "./UpdateBadge";
import { UserMenu } from "./UserMenu";
import { Logo } from "./ui";

const SIDEBAR_KEY = "netpulse.sidebar";

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === "collapsed";
  } catch {
    return false;
  }
}

/** Układ aplikacji: pasek górny (konto, motyw), menu po lewej, treść. */
export function Shell() {
  const { status } = useAuth();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [drawer, setDrawer] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_KEY, collapsed ? "collapsed" : "expanded");
    } catch {
      /* bez zapamiętywania */
    }
  }, [collapsed]);

  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setDrawer(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawer]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border bg-surface px-3 sm:px-4">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setDrawer((v) => !v)}
            aria-label={drawer ? t("nav.close") : t("nav.open")}
            aria-expanded={drawer}
            className="flex size-9 items-center justify-center rounded-lg text-text-2 hover:bg-surface-2 lg:hidden"
          >
            {drawer ? <IconX size={20} aria-hidden="true" /> : <IconMenu2 size={20} aria-hidden="true" />}
          </button>
          <Logo size={28} />
          <span className="text-base font-medium">{t("app.name")}</span>
        </div>
        <div className="flex items-center gap-1">
          <UpdateBadge />
          <RefreshControl />
          <ThemeToggle />
          <UserMenu />
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1">
        {drawer && (
          <div className="fixed inset-0 top-14 z-20 bg-black/40 lg:hidden" onClick={() => setDrawer(false)} aria-hidden="true" />
        )}
        <aside
          className={[
            "z-30 shrink-0 border-r border-border bg-surface transition-[width,transform] duration-200",
            "max-lg:fixed max-lg:inset-y-0 max-lg:top-14 max-lg:w-64",
            drawer ? "max-lg:translate-x-0" : "max-lg:-translate-x-full",
            collapsed ? "lg:w-16" : "lg:w-60",
          ].join(" ")}
        >
          <Sidebar
            version={status?.version}
            collapsed={collapsed}
            onToggleCollapsed={() => setCollapsed((v) => !v)}
            onNavigate={() => setDrawer(false)}
          />
        </aside>

        <main className="min-w-0 flex-1 overflow-y-auto p-4 sm:p-6">
          <Routes>
            {modules.flatMap((m) => {
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
        </main>
      </div>
    </div>
  );
}
