import { IconCheck, IconChevronDown, IconDeviceDesktop, IconLogout, IconMoon, IconSettings, IconSun } from "@tabler/icons-react";
import { useRef, useState } from "react";
import { Link } from "react-router";
import { useAuth, useUser } from "../auth/AuthProvider";
import { t } from "../i18n";
import { initials } from "../lib/format";
import { useDismiss } from "../lib/useDismiss";
import { ROLE_LABEL, roleOf } from "../lib/roles";
import { REFRESH_OPTIONS, useRefresh } from "../lib/refresh";
import { useTheme } from "../lib/theme";
import { refreshLabel } from "./RefreshControl";

const THEME_LABEL = { system: "theme.system", light: "theme.light", dark: "theme.dark" } as const;
const THEME_ICON = { system: IconDeviceDesktop, light: IconSun, dark: IconMoon } as const;

/** Nazwa zalogowanego użytkownika z rozwijanym menu: ustawienia konta i wylogowanie.
 *  Na telefonie (< 640 px) menu ma też motyw i interwał odświeżania – w pasku górnym nie ma na nie miejsca. */
export function UserMenu() {
  const user = useUser();
  const { logout } = useAuth();
  const { pref, cycle } = useTheme();
  const { refreshSeconds, setRefreshSeconds } = useRefresh();
  const [open, setOpen] = useState(false);
  const ThemeIcon = THEME_ICON[pref];
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useDismiss(open, () => setOpen(false), root, trigger);

  const itemClass =
    "flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-text hover:bg-surface-2 focus-visible:bg-surface-2";

  return (
    <div ref={root} className="relative">
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("user.menu")}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-lg py-1 pl-1 pr-2 hover:bg-surface-2"
      >
        <span className="flex size-8 items-center justify-center rounded-full bg-accent-soft text-xs font-medium text-accent-text">
          {initials(user.username)}
        </span>
        <span className="hidden max-w-40 truncate text-sm font-medium sm:block">{user.username}</span>
        <IconChevronDown size={16} aria-hidden="true" className="hidden text-muted sm:block" />
      </button>

      {open && (
        <div
          role="menu"
          aria-label={t("user.menu")}
          className="absolute right-0 top-full z-30 mt-2 max-h-[calc(100dvh-5rem)] w-56 overflow-y-auto rounded-xl border border-border bg-surface py-1 shadow-lg"
        >
          <div className="border-b border-border px-3 py-2">
            <p className="truncate text-sm font-medium">{user.username}</p>
            <p className="text-xs text-muted">{t(ROLE_LABEL[roleOf(user)])}</p>
          </div>
          <div className="border-b border-border py-1 sm:hidden">
            <button type="button" role="menuitem" className={itemClass} onClick={cycle} title={t("theme.switch")}>
              <ThemeIcon size={18} aria-hidden="true" className="text-text-2" />
              {t(THEME_LABEL[pref])}
            </button>
            <p className="px-3 pb-1 pt-2 text-xs font-medium text-muted">{t("refresh.auto")}</p>
            {REFRESH_OPTIONS.map((s) => (
              <button
                key={s}
                type="button"
                role="menuitemradio"
                aria-checked={s === refreshSeconds}
                className={`${itemClass} justify-between`}
                onClick={() => {
                  setRefreshSeconds(s);
                  setOpen(false);
                }}
              >
                {refreshLabel(s)}
                {s === refreshSeconds && <IconCheck size={16} aria-hidden="true" className="text-accent-text" />}
              </button>
            ))}
          </div>
          <Link to="/settings/account" role="menuitem" className={itemClass} onClick={() => setOpen(false)}>
            <IconSettings size={18} aria-hidden="true" className="text-text-2" />
            {t("user.settings")}
          </Link>
          <button
            type="button"
            role="menuitem"
            className={itemClass}
            onClick={() => {
              setOpen(false);
              void logout();
            }}
          >
            <IconLogout size={18} aria-hidden="true" className="text-text-2" />
            {t("user.logout")}
          </button>
        </div>
      )}
    </div>
  );
}
