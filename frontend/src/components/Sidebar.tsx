import { IconChevronsLeft, IconChevronsRight } from "@tabler/icons-react";
import { NavLink, useLocation } from "react-router";
import { t } from "../i18n";
import { useAlertSummary } from "../lib/alerts";
import { NAV_GROUPS, useVisibleModules, type NavModule } from "../modules";
import { Logo } from "./ui";

// Wygląd „Błękit” (0.58.0): aktywna pozycja to kafelek w kolorze karty z niebieską ikoną
const linkBase = "relative flex min-h-10 items-center gap-3 rounded-[10px] border px-3 text-sm transition-colors";
const linkIdle = "border-transparent font-medium text-text-2 hover:bg-surface hover:text-text";
const linkActive = "border-border bg-surface font-semibold text-text shadow-[var(--shadow-card)] [&>svg]:text-accent";


interface SidebarProps {
  version?: string;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** Wywoływane po wybraniu pozycji (zamyka szufladę na telefonie). */
  onNavigate: () => void;
}

/**
 * Menu po lewej: logo i grupy Monitoring, Zdarzenia, Integracje, System (pole `group` w rejestrze modułów; pusta grupa
 * znika, np. Integracje przy wyłączonych modułach). Alerty mają plakietkę z liczbą niepotwierdzonych aktywnych alertów.
 * Podstrony widać po wejściu w moduł.
 */
export function Sidebar({ version, collapsed, onToggleCollapsed, onNavigate }: SidebarProps) {
  const { pathname } = useLocation();
  const CollapseIcon = collapsed ? IconChevronsRight : IconChevronsLeft;
  const modules = useVisibleModules().filter((m) => !m.hidden);
  const groups = NAV_GROUPS.map((g) => ({
    label: t(`nav.group.${g}`),
    items: modules.filter((m) => (m.group ?? "monitoring") === g),
  })).filter((g) => g.items.length > 0);
  const { data: alerts } = useAlertSummary();
  const unacked = alerts?.unacked ?? 0;
  const badgeTone = alerts?.unacked_critical ? "bg-danger-soft text-danger" : "bg-warning-soft text-warning";

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
            const style = parentOnly ? "border-transparent font-semibold text-text hover:bg-surface [&>svg]:text-accent" : inModule ? linkActive : linkIdle;
            return `${linkBase} ${style} ${collapsed ? "justify-center" : ""}`;
          }}
        >
          <Icon size={19} stroke={1.8} aria-hidden="true" className="shrink-0" />
          <span className={collapsed ? "sr-only" : "flex-1"}>{t(m.label)}</span>
          {m.id === "alerts" && unacked > 0 && (
            <>
              <span className="sr-only">{t("alerts.bell.count", { n: unacked })}</span>
              {collapsed ? (
                <span aria-hidden="true" className={`absolute right-2 top-1.5 size-2 rounded-full ${alerts?.unacked_critical ? "bg-danger" : "bg-warning"}`} />
              ) : (
                <span aria-hidden="true" className={`min-w-5 rounded-full px-1.5 text-center text-[11px] font-semibold leading-5 ${badgeTone}`}>
                  {unacked > 99 ? "99+" : unacked}
                </span>
              )}
            </>
          )}
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
            <span className="px-3 pb-1.5 pt-3 text-[11px] font-medium uppercase tracking-[0.06em] text-muted">{g.label}</span>
          )}
          <ul className="flex flex-col gap-0.5">{g.items.map(renderItem)}</ul>
        </div>
      ))}

      <div className="mt-auto flex items-center gap-2 pt-4">
        {!collapsed && version && (
          <div className="flex min-w-0 flex-1 flex-col rounded-xl bg-accent-soft px-3 py-2">
            <span className="text-[13px] font-semibold text-accent-text">
              {t("app.name")} {version}
            </span>
          </div>
        )}
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-label={collapsed ? t("nav.expand") : t("nav.collapse")}
          title={collapsed ? t("nav.expand") : t("nav.collapse")}
          className={`hidden size-10 shrink-0 items-center justify-center rounded-[10px] text-text-2 hover:bg-surface hover:text-text lg:flex ${collapsed ? "mx-auto" : ""}`}
        >
          <CollapseIcon size={18} aria-hidden="true" />
        </button>
      </div>
    </nav>
  );
}
