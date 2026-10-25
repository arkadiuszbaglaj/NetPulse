import { IconBell } from "@tabler/icons-react";
import { Link } from "react-router";
import { t } from "../i18n";
import { useAlertSummary } from "../lib/alerts";

/** Dzwonek w pasku górnym: liczba aktywnych alertów, kolor według najgroźniejszego; klik prowadzi do listy. */
export function AlertBell() {
  const { data } = useAlertSummary();
  const firing = data?.firing ?? 0;
  const tone = data?.critical ? "bg-danger text-surface" : firing > 0 ? "bg-accent text-on-accent" : "";
  const label = firing > 0 ? t("alerts.bell.count", { n: firing }) : t("alerts.bell.none");
  return (
    <Link
      to="/alerts"
      aria-label={label}
      title={label}
      className="relative flex size-9 items-center justify-center rounded-lg text-text-2 hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
    >
      <IconBell size={20} aria-hidden="true" />
      {firing > 0 && (
        <span
          aria-hidden="true"
          className={`absolute right-0.5 top-0.5 flex min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-medium leading-4 ${tone}`}
        >
          {firing > 99 ? "99+" : firing}
        </span>
      )}
    </Link>
  );
}
