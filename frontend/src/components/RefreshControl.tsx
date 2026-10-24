import { IconCheck, IconChevronDown, IconRefresh } from "@tabler/icons-react";
import { useRef, useState } from "react";
import { t } from "../i18n";
import { useDashboardSummary } from "../lib/queries";
import { REFRESH_OPTIONS, useRefresh, type RefreshSeconds } from "../lib/refresh";
import { useDismiss } from "../lib/useDismiss";

export function refreshLabel(seconds: RefreshSeconds): string {
  if (seconds === 0) return t("refresh.off");
  const value = seconds >= 60 ? `${seconds / 60} min` : `${seconds} s`;
  return t("refresh.every", { value });
}

/** Pasek górny: odśwież teraz + wybór interwału automatycznego odświeżania (wspólny dla całego panelu). */
export function RefreshControl() {
  const { refreshSeconds, setRefreshSeconds, refreshNow, isRefreshing } = useRefresh();
  const { data: summary } = useDashboardSummary();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useDismiss(open, () => setOpen(false), root, trigger);

  const pollInterval = summary?.poll_interval_s;
  const tooFast = refreshSeconds > 0 && pollInterval !== undefined && refreshSeconds < pollInterval;

  return (
    <div ref={root} className="relative flex items-center">
      <button
        type="button"
        onClick={refreshNow}
        aria-label={t("refresh.now")}
        title={t("refresh.now")}
        className="flex size-9 items-center justify-center rounded-lg text-text-2 hover:bg-surface-2 hover:text-text"
      >
        <IconRefresh size={20} aria-hidden="true" className={isRefreshing ? "animate-spin" : ""} />
      </button>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${t("refresh.auto")}: ${refreshLabel(refreshSeconds)}`}
        onClick={() => setOpen((v) => !v)}
        className="flex h-9 items-center gap-1 rounded-lg px-2 text-sm text-text-2 hover:bg-surface-2 hover:text-text"
      >
        <span className="hidden sm:inline">{refreshLabel(refreshSeconds)}</span>
        <IconChevronDown size={16} aria-hidden="true" />
      </button>

      {open && (
        <div
          role="menu"
          aria-label={t("refresh.auto")}
          className="absolute right-0 top-full z-30 mt-2 w-64 overflow-hidden rounded-xl border border-border bg-surface py-1 shadow-lg"
        >
          <p className="px-3 py-1.5 text-xs font-medium text-muted">{t("refresh.auto")}</p>
          {REFRESH_OPTIONS.map((s) => (
            <button
              key={s}
              type="button"
              role="menuitemradio"
              aria-checked={s === refreshSeconds}
              onClick={() => {
                setRefreshSeconds(s);
                setOpen(false);
              }}
              className="flex w-full items-center justify-between px-3 py-2 text-left text-sm text-text hover:bg-surface-2 focus-visible:bg-surface-2"
            >
              {refreshLabel(s)}
              {s === refreshSeconds && <IconCheck size={16} aria-hidden="true" className="text-accent" />}
            </button>
          ))}
          {pollInterval !== undefined && (
            <p className={`border-t border-border px-3 py-2 text-xs ${tooFast ? "text-warning" : "text-muted"}`}>
              {t("refresh.hint", { seconds: pollInterval })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
