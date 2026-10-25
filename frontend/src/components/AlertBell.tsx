import { IconBell } from "@tabler/icons-react";
import { Link } from "react-router";
import { t } from "../i18n";
import { useAlertSummary } from "../lib/alerts";

/**
 * Dzwonek w pasku górnym: liczba niepotwierdzonych aktywnych alertów, kolor według najgroźniejszego z nich;
 * potwierdzone alerty nie zapalają plakietki (dalej są na liście). Klik prowadzi do listy.
 */
export function AlertBell() {
  const { data } = useAlertSummary();
  const firing = data?.firing ?? 0;
  const unacked = data?.unacked ?? 0;
  const tone = data?.unacked_critical ? "bg-danger text-surface" : "bg-accent text-on-accent";
  const label =
    unacked > 0
      ? t("alerts.bell.count", { n: unacked })
      : firing > 0
        ? t("alerts.bell.acked", { n: firing })
        : t("alerts.bell.none");
  return (
    <Link
      to="/alerts"
      aria-label={label}
      title={label}
      className="relative flex size-9 items-center justify-center rounded-lg text-text-2 hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
    >
      <IconBell size={20} aria-hidden="true" />
      {unacked > 0 && (
        <span
          aria-hidden="true"
          className={`absolute right-0.5 top-0.5 flex min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-medium leading-4 ${tone}`}
        >
          {unacked > 99 ? "99+" : unacked}
        </span>
      )}
    </Link>
  );
}
