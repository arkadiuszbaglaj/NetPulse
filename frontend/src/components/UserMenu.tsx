import { IconChevronDown, IconLogout, IconSettings } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { useAuth, useUser } from "../auth/AuthProvider";
import { t } from "../i18n";
import { initials } from "../lib/format";

/** Nazwa zalogowanego użytkownika z rozwijanym menu: ustawienia konta i wylogowanie. */
export function UserMenu() {
  const user = useUser();
  const { logout } = useAuth();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

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
        <span className="flex size-8 items-center justify-center rounded-full bg-accent-soft text-xs font-medium text-accent">
          {initials(user.username)}
        </span>
        <span className="hidden max-w-40 truncate text-sm font-medium sm:block">{user.username}</span>
        <IconChevronDown size={16} aria-hidden="true" className="text-muted" />
      </button>

      {open && (
        <div
          role="menu"
          aria-label={t("user.menu")}
          className="absolute right-0 top-full z-30 mt-2 w-56 overflow-hidden rounded-xl border border-border bg-surface py-1 shadow-lg"
        >
          <div className="border-b border-border px-3 py-2">
            <p className="truncate text-sm font-medium">{user.username}</p>
            <p className="text-xs text-muted">{user.is_admin ? t("user.role.admin") : ""}</p>
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
