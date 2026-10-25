import { IconChevronsLeft, IconChevronsRight } from "@tabler/icons-react";
import { NavLink, useLocation } from "react-router";
import { t } from "../i18n";
import { useVisibleModules } from "../modules";

const linkBase = "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors";
const linkIdle = "text-text-2 hover:bg-surface-2 hover:text-text";
const linkActive = "bg-accent-soft font-medium text-accent";

interface SidebarProps {
  version?: string;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** Wywoływane po wybraniu pozycji (zamyka szufladę na telefonie). */
  onNavigate: () => void;
}

/** Menu po lewej. Pozycje pochodzą z rejestru modułów; podstrony widać po wejściu w moduł. */
export function Sidebar({ version, collapsed, onToggleCollapsed, onNavigate }: SidebarProps) {
  const { pathname } = useLocation();
  const CollapseIcon = collapsed ? IconChevronsRight : IconChevronsLeft;
  const modules = useVisibleModules().filter((m) => !m.hidden);

  return (
    <nav aria-label={t("nav.main")} className="flex h-full flex-col gap-1 p-3">
      <ul className="flex flex-col gap-1">
        {modules.map((m) => {
          const Icon = m.icon;
          const inModule = m.path === "/" ? pathname === "/" : pathname === m.path || pathname.startsWith(`${m.path}/`);
          const target = m.children ? `${m.path}/${m.children[0].path}` : m.path;
          return (
            <li key={m.id}>
              <NavLink
                to={target}
                end={m.path === "/"}
                title={collapsed ? t(m.label) : undefined}
                onClick={onNavigate}
                className={() => {
                  // Moduł z podstronami: gdy jest rozwinięty, pełne podświetlenie ma tylko aktywna podstrona
                  const parentOnly = inModule && m.children && !collapsed;
                  const style = parentOnly ? "font-medium text-text hover:bg-surface-2" : inModule ? linkActive : linkIdle;
                  return `${linkBase} ${style} ${collapsed ? "justify-center" : ""}`;
                }}
              >
                <Icon size={20} aria-hidden="true" className="shrink-0" />
                <span className={collapsed ? "sr-only" : ""}>{t(m.label)}</span>
              </NavLink>
              {m.children && inModule && !collapsed && (
                <ul className="ml-5 mt-1 flex flex-col gap-0.5 border-l border-border pl-2">
                  {m.children.map((c) => {
                    const ChildIcon = c.icon;
                    return (
                      <li key={c.path}>
                        <NavLink
                          to={`${m.path}/${c.path}`}
                          onClick={onNavigate}
                          className={({ isActive }) => `${linkBase} py-1.5 ${isActive ? linkActive : linkIdle}`}
                        >
                          <ChildIcon size={18} aria-hidden="true" className="shrink-0" />
                          {t(c.label)}
                        </NavLink>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>

      <div className="mt-auto flex items-center justify-between gap-2 pt-3">
        {!collapsed && version && <span className="px-3 text-xs text-muted">v{version}</span>}
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-label={collapsed ? t("nav.expand") : t("nav.collapse")}
          title={collapsed ? t("nav.expand") : t("nav.collapse")}
          className="hidden size-9 items-center justify-center rounded-lg text-text-2 hover:bg-surface-2 hover:text-text lg:flex"
        >
          <CollapseIcon size={18} aria-hidden="true" />
        </button>
      </div>
    </nav>
  );
}
