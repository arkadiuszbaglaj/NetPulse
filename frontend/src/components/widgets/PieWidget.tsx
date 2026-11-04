/** Wykres kołowy (0.39.0): pierścień w SVG z dużą liczbą w środku i legendą – bez ECharts.
 * Porty, CPU, RAM i dyski urządzeń SNMP biorą dane na żywo (co ~1,5 s) z WebSocketu; na pulpicie publicznym,
 * po utracie połączenia i dla agentów / Proxmoksa – odczyty z bazy. */
import { useQuery } from "@tanstack/react-query";
import { useContext, useMemo } from "react";
import { t } from "../../i18n";
import { ApiError, get, type Device } from "../../lib/api";
import type { PieConfig } from "../../lib/layout";
import { useLiveSample } from "../../lib/liveHub";
import { useCollection } from "../../lib/panels";
import { applyLive, isLiveMetric, isPortMetric, NON_SNMP_DRIVERS, pieCollection, pieData, pieTitle, type PieSlice } from "../../lib/pie";
import { PublicModeContext } from "../../lib/publicMode";
import { Card } from "../ui";
import { WidgetActions } from "./WidgetActions";

const R = 40;
const C = 2 * Math.PI * R;
const pctFormat = new Intl.NumberFormat("pl", { maximumFractionDigits: 1 });

function Ring({ slices, label }: { slices: PieSlice[]; label: string }) {
  const total = slices.reduce((sum, s) => sum + s.value, 0) || 1;
  let offset = 0;
  return (
    <svg viewBox="0 0 100 100" role="img" aria-label={label} className="h-full w-full -rotate-90">
      <circle cx={50} cy={50} r={R} fill="none" stroke="var(--surface-2)" strokeWidth={14} />
      {slices.map((s) => {
        const len = (s.value / total) * C;
        const dash = (
          <circle
            key={s.key}
            cx={50}
            cy={50}
            r={R}
            fill="none"
            stroke={s.color}
            strokeWidth={14}
            strokeDasharray={`${len} ${C - len}`}
            strokeDashoffset={-offset}
          >
            <title>{`${s.label}: ${s.text}`}</title>
          </circle>
        );
        offset += len;
        return dash;
      })}
    </svg>
  );
}

export function PieWidget({ config }: { config: PieConfig }) {
  const query = useCollection(pieCollection(config));
  // Urządzenie: nazwa do tytułu i driver (bez SNMP – bez danych na żywo); na pulpicie publicznym lista urządzeń
  // nie jest dostępna, a WebSocket wymaga logowania – tam zostają odczyty z bazy
  const isPublic = useContext(PublicModeContext);
  const devices = useQuery({ queryKey: ["devices"], queryFn: () => get<Device[]>("/api/devices"), enabled: !isPublic && !!config.device_id });
  const device = config.device_id ? devices.data?.find((d) => d.id === config.device_id) : undefined;
  const deviceName = device?.name ?? null;
  // Wspólny kanał na żywo (0.45.0): jedno połączenie na urządzenie, przełącznik w pasku górnym
  const live = useLiveSample(config.device_id, isLiveMetric(config.metric) && !isPublic && !!device && device.status === "up" && !NON_SNMP_DRIVERS.has(device.driver)) ?? { status: "lost" as const, sample: null };
  const merged = useMemo(
    () => (live.status === "live" && live.sample && query.data ? applyLive(config, query.data, live.sample) : { rows: query.data, applied: false }),
    [live.status, live.sample, query.data, config],
  );
  const rows = merged.rows;
  const isLive = merged.applied;
  const itemLabel = isPortMetric(config.metric) ? rows?.find((r) => r.key === config.item)?.label : null;
  const title = pieTitle(config, deviceName, itemLabel);
  const data = rows ? pieData(config, rows) : null;
  const total = data ? data.slices.reduce((sum, s) => sum + s.value, 0) : 0;

  return (
    <Card className="flex h-full flex-col p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="truncate text-sm font-medium">{title}</h2>
        <div className="flex shrink-0 items-center gap-1">
          {isLive && (
            <span className="inline-flex items-center gap-1 text-xs text-success" title={t("pie.live.hint")}>
              <span aria-hidden="true" className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" />
              {t("pie.live")}
            </span>
          )}
          <WidgetActions />
        </div>
      </div>
      {query.isError ? (
        <p role="alert" className="py-6 text-center text-sm text-danger">
          {query.error instanceof ApiError && query.error.status === 404 ? t("panel.gone") : t("chart.error")}
        </p>
      ) : query.isLoading ? (
        <p role="status" className="py-6 text-center text-sm text-text-2">
          {t("chart.loading")}
        </p>
      ) : !data ? (
        <p role="status" className="py-6 text-center text-sm text-text-2">
          {t("pie.empty")}
        </p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-wrap items-center justify-center gap-4">
          <div className="np-ring relative aspect-square w-36 shrink-0">
            <Ring slices={data.slices} label={`${title}: ${data.slices.map((s) => `${s.label} ${s.text}`).join(", ")}`} />
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
              <span className="np-ring-value text-xl font-semibold tabular-nums">{data.center}</span>
              <span className="max-w-20 truncate text-xs text-text-2">{data.sub}</span>
            </div>
          </div>
          <ul aria-label={t("chart.legend")} className="flex min-w-36 flex-1 flex-col gap-1 text-xs">
            {data.slices.map((s) => (
              <li key={s.key} className="flex items-center gap-2">
                <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: s.color }} />
                <span className="min-w-0 flex-1 truncate text-text-2" title={s.label}>
                  {s.label}
                </span>
                <span className="shrink-0 font-medium tabular-nums">{s.text}</span>
                {/* Udział w % tylko, gdy wartość nie jest już procentem (CPU, RAM) */}
                {!s.text.endsWith("%") && <span className="w-12 shrink-0 text-right tabular-nums text-text-2">{pctFormat.format((s.value / total) * 100)}%</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
