import { t } from "../i18n";

/** Znacznik „Na żywo” przy wartości odświeżanej co ~1,5 s (0.45.0). `compact` – sama kropka z opisem dla czytnika. */
export function LiveBadge({ compact = false }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-success" title={t("live.hint")}>
      <span aria-hidden="true" className="size-1.5 animate-pulse rounded-full bg-success" />
      <span className={compact ? "sr-only" : ""}>{t("live.badge")}</span>
    </span>
  );
}
