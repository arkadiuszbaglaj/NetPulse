import { useMemo } from "react";
import { t } from "../../i18n";
import { formatBps } from "../../lib/format";
import { autoColor, type ChartHeight, type WanMetric } from "../../lib/layout";
import { useRefresh, type RangeMinutes } from "../../lib/refresh";
import { forDevice, useWanHistory, type WanLink, type WanSegment, type WanSwitch } from "../../lib/wan";
import { ChartCard } from "../charts/ChartCard";
import type { ChartSeries } from "../charts/TimeSeriesChart";
import { WAN_STATE_LABEL } from "./WanStatusWidget";

const HEIGHT = { sm: 180, md: 240, lg: 340 } as const;
const BAND = { active: "bg-success", standby: "bg-danger/30", down: "bg-danger" } as const;
const timeFmt = new Intl.DateTimeFormat("pl", { dateStyle: "short", timeStyle: "short" });

/** Pas stanu łącza na osi czasu: zielony – ruch idzie tym łączem, jasnoczerwony – zapas, czerwony – awaria. */
function StateBand({ link, segments, from, to }: { link: WanLink; segments: WanSegment[]; from: number; to: number }) {
  const span = Math.max(1, to - from);
  const pct = (iso: string) => Math.min(100, Math.max(0, ((new Date(iso).getTime() - from) / span) * 100));
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-24 shrink-0 truncate text-text-2">{link.name}</span>
      <div role="list" aria-label={t("wan.band", { name: link.name })} className="relative h-3 flex-1 overflow-hidden rounded bg-surface-2">
        {segments.map((s) => {
          const left = pct(s.start);
          const label = `${t(WAN_STATE_LABEL[s.state])}: ${timeFmt.format(new Date(s.start))} – ${timeFmt.format(new Date(s.end))}`;
          return (
            <span
              key={`${s.start}-${s.state}`}
              role="listitem"
              aria-label={label}
              title={label}
              className={`absolute inset-y-0 ${BAND[s.state]}`}
              style={{ left: `${left}%`, width: `${Math.max(0.3, pct(s.end) - left)}%` }}
            />
          );
        })}
      </div>
    </div>
  );
}

function switchText(sw: WanSwitch, names: Map<number, string>): string {
  const list = (ids: number[]) => ids.map((id) => names.get(id) ?? `#${id}`).join(" + ");
  return t("wan.switch", { from: list(sw.from_ids), to: list(sw.to_ids), time: timeFmt.format(new Date(sw.time)) });
}

/** Wykres aktywnego łącza: osobna linia dla każdego WAN-u, rysowana tylko wtedy, gdy ruch szedł tym łączem –
 * po awarii WAN 1 linia WAN 2 zaczyna się w chwili przełączenia. Pod wykresem pasy stanu i lista przełączeń. */
export function WanChartWidget({
  deviceId,
  metric,
  rangeMin,
  height,
}: {
  deviceId?: number | null;
  metric: WanMetric;
  rangeMin?: RangeMinutes | null;
  height: ChartHeight;
}) {
  const global = useRefresh();
  const minutes = rangeMin ?? global.rangeMinutes;
  const { data, isLoading, isError } = useWanHistory(minutes);
  const links = useMemo(() => forDevice(data?.links ?? [], deviceId), [data, deviceId]);
  const prefix = metric === "in_bps" ? "in" : "out";
  const series: ChartSeries[] = useMemo(
    () => links.map((l, i) => ({ key: `${prefix}_${l.id}`, name: l.name, color: autoColor(i), area: false })),
    [links, prefix],
  );
  const ids = new Set(links.map((l) => l.id));
  const names = new Map(links.map((l) => [l.id, l.name]));
  const switches = (data?.switches ?? []).filter((sw) => sw.to_ids.some((id) => ids.has(id))).slice(-5).reverse();
  const to = Date.now();
  const from = to - minutes * 60_000;
  const title = `${t("widget.type.wan_chart")} – ${t(metric === "in_bps" ? "chart.traffic.in" : "chart.traffic.out").toLowerCase()}`;

  if (data && links.length === 0) {
    return (
      <ChartCard title={title} series={[]} data={{ interval_s: data.interval_s, points: [] }} isLoading={false} isError={false} format={formatBps} rangeMinutes={minutes}>
        <p className="text-xs text-text-2">{t("wan.none")}</p>
      </ChartCard>
    );
  }
  return (
    <ChartCard
      title={title}
      series={series}
      data={data ? { interval_s: data.interval_s, points: data.points } : undefined}
      isLoading={isLoading}
      isError={isError}
      format={formatBps}
      rangeMinutes={minutes}
      kind="line"
      height={HEIGHT[height]}
      errorText={t("wan.error")}
    >
      {data && (
        <div className="mb-2 flex flex-col gap-1.5">
          {links.map((l) => (
            <StateBand key={l.id} link={l} segments={data.segments.filter((s) => s.link_id === l.id)} from={from} to={to} />
          ))}
          {switches.length > 0 && (
            <ul aria-label={t("wan.switches")} className="mt-1 text-xs text-text-2">
              {switches.map((sw) => (
                <li key={sw.time}>{switchText(sw, names)}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </ChartCard>
  );
}
