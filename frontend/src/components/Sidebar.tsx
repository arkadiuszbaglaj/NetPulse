import { IconChevronsLeft, IconChevronsRight } from "@tabler/icons-react";
import { NavLink, useLocation } from "react-router";
import { t } from "../i18n";
import { useVisibleModules, type NavModule } from "../modules";
import { Logo } from "./ui";

const linkBase = "flex min-h-10 items-center gap-3 rounded-lg px-3 text-sm transition-colors";
const linkIdle = "font-medium text-text-2 hover:bg-surface-2 hover:text-text";
const linkActive = "bg-surface-2 font-semibold text-text";

/** Pozycje „systemowe” (ustawienia) idą do osobnej grupy pod monitorowaniem. */
const SYSTEM_MODULES = new Set(["settings"]);

interface SidebarProps {
  version?: string;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** Wywoływane po wybraniu pozycji (zamyka szufladę na telefonie). */
  onNavigate: () => void;
}

/** Menu po lewej: logo, grupy „Monitorowanie” i „System”. Pozycje pochodzą z rejestru modułów; podstrony widać po wejściu w moduł. */
export function Sidebar({ version, collapsed, onToggleCollapsed, onNavigate }: SidebarProps) {
  const { pathname } = useLocation();
  const CollapseIcon = collapsed ? IconChevronsRight : IconChevronsLeft;
  const modules = useVisibleModules().filter((m) => !m.hidden);
  const groups = [
    { label: t("nav.group.monitoring"), items: modules.filter((m) => !SYSTEM_MODULES.has(m.id)) },
    { label: t("nav.group.system"), items: modules.filter((m) => SYSTEM_MODULES.has(m.id)) },
  ].filter((g) => g.items.length > 0);

  const renderItem = (m: NavModule) => {
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
            const style = parentOnly ? "font-semibold text-text hover:bg-surface-2" : inModule ? linkActive : linkIdle;
            return `${linkBase} ${style} ${collapsed ? "justify-center" : ""}`;
          }}
        >
          <Icon size={19} stroke={1.8} aria-hidden="true" className="shrink-0" />
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
                    className={({ isActive }) => `${linkBase} min-h-9 ${isActive ? linkActive : linkIdle}`}
                  >
                    <ChildIcon size={17} stroke={1.8} aria-hidden="true" className="shrink-0" />
                    {t(c.label)}
                  </NavLink>
                </li>
              );
            })}
          </ul>
        )}
      </li>
    );
  };

  return (
    <nav aria-label={t("nav.main")} className="flex h-full flex-col overflow-y-auto px-3 pb-3">
      <div className={`flex h-16 shrink-0 items-center gap-2.5 ${collapsed ? "justify-center" : "px-2"}`}>
        <Logo size={30} />
        {!collapsed && <span className="text-[17px] font-bold tracking-tight">{t("app.name")}</span>}
      </div>

      {groups.map((g) => (
        <div key={g.label} className="mt-2 flex flex-col gap-0.5">
          {collapsed ? (
            <span className="sr-only">{g.label}</span>
          ) : (
            <span className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted">{g.label}</span>
          )}
          <ul className="flex flex-col gap-0.5">{g.items.map(renderItem)}</ul>
        </div>
      ))}

      <div className="mt-auto flex items-center gap-2 pt-4">
        {!collapsed && version && (
          <div className="flex min-w-0 flex-1 flex-col rounded-lg border border-border px-3 py-2">
            <span className="text-[13px] font-semibold">
              {t("app.name")} {version}
            </span>
          </div>
        )}
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-label={collapsed ? t("nav.expand") : t("nav.collapse")}
          title={collapsed ? t("nav.expand") : t("nav.collapse")}
          className={`hidden size-10 shrink-0 items-center justify-center rounded-lg text-text-2 hover:bg-surface-2 hover:text-text lg:flex ${collapsed ? "mx-auto" : ""}`}
        >
          <CollapseIcon size={18} aria-hidden="true" />
        </button>
      </div>
    </nav>
  );
}
