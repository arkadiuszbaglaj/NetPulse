import { IconShieldCheck } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { t, type TextKey } from "../../i18n";
import {
  availabilityTone,
  formatAvailability,
  formatDuration,
  SLA_DAYS,
  useWanSla,
  type SlaDays,
  type WanLinkSla,
} from "../../lib/wan";
import { Card, ErrorNote } from "../ui";

const TONE = { ok: "text-success", warn: "text-warning", danger: "text-danger", none: "text-text-2" } as const;
const dateFmt = new Intl.DateTimeFormat("pl", { dateStyle: "short", timeStyle: "short" });

function LinkSla({ item }: { item: WanLinkSla }) {
  const last = item.recent_outages[0];
  return (
    <li className="py-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <p className="min-w-0 truncate text-sm">
          <span className="font-medium">{item.link.name}</span>
          <span className="ml-2 text-xs text-text-2">
            {item.link.device_name} · {item.link.interface_label}
          </span>
        </p>
        <p aria-label={t("wan.sla.availabilityOf", { name: item.link.name })} className={`shrink-0 text-lg font-medium ${TONE[availabilityTone(item.availability)]}`}>
          {formatAvailability(item.availability)}
        </p>
      </div>
      <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs sm:grid-cols-4">
        <div>
          <dt className="text-text-2">{t("wan.sla.outages")}</dt>
          <dd>{item.outages}</dd>
        </div>
        <div>
          <dt className="text-text-2">{t("wan.sla.downtime")}</dt>
          <dd>{formatDuration(item.down_s)}</dd>
        </div>
        <div>
          <dt className="text-text-2">{t("wan.sla.longest")}</dt>
          <dd>{item.outages ? formatDuration(item.longest_outage_s) : "–"}</dd>
        </div>
        <div>
          <dt className="text-text-2">{t("wan.sla.activeTime")}</dt>
          <dd>{formatDuration(item.active_s)}</dd>
        </div>
      </dl>
      {last && (
        <p className={`mt-1 text-xs ${last.ongoing ? "text-danger" : "text-text-2"}`}>
          {last.ongoing
            ? t("wan.sla.ongoing", { start: dateFmt.format(new Date(last.start)), duration: formatDuration(last.duration_s) })
            : t("wan.sla.last", { start: dateFmt.format(new Date(last.start)), duration: formatDuration(last.duration_s) })}
        </p>
      )}
      {item.unknown_s > 0 && item.availability != null && item.unknown_s >= 60 && (
        <p className="mt-0.5 text-xs text-text-2">{t("wan.sla.noData", { duration: formatDuration(item.unknown_s) })}</p>
      )}
    </li>
  );
}

/** SLA łączy WAN: dostępność w %, liczba i czas przerw za 24 godz., 7 albo 30 dni (okres zmienia się w karcie). */
export function WanSlaWidget({ deviceId, days }: { deviceId?: number | null; days: SlaDays }) {
  const [period, setPeriod] = useState<SlaDays>(days);
  useEffect(() => setPeriod(days), [days]); // okres z ustawień widgetu po edycji
  const { data, isLoading, isError } = useWanSla(period);
  const items = (data?.links ?? []).filter((x) => deviceId == null || x.link.device_id === deviceId);
  return (
    <Card className="h-full p-4">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <IconShieldCheck size={18} aria-hidden="true" className="shrink-0 text-accent" />
          {t("widget.type.wan_sla")}
        </h3>
        <div role="group" aria-label={t("wan.sla.period")} className="flex gap-1">
          {SLA_DAYS.map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={period === d}
              onClick={() => setPeriod(d)}
              className={`rounded-md px-2 py-0.5 text-xs ${period === d ? "bg-accent-soft font-medium text-accent" : "text-text-2 hover:bg-surface-2"}`}
            >
              {t(`wan.sla.days.${d}` as TextKey)}
            </button>
          ))}
        </div>
      </div>
      {isError ? (
        <ErrorNote>{t("wan.error")}</ErrorNote>
      ) : data && items.length === 0 ? (
        <p className="py-4 text-sm text-text-2">{t("wan.none")}</p>
      ) : data ? (
        <ul className="divide-y divide-border">
          {items.map((x) => (
            <LinkSla key={x.link.id} item={x} />
          ))}
        </ul>
      ) : (
        isLoading && <p className="py-4 text-sm text-text-2">{t("app.loading")}</p>
      )}
    </Card>
  );
}
