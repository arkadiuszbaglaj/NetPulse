/** Panele od 0.27.0: liczba z mini-wykresem, paski, tabela i oś stanów. Bez ECharts – lekkie SVG i HTML. */
import { IconArrowDown, IconArrowUp } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Fragment, useMemo, useState, type ReactNode } from "react";
import { t } from "../../i18n";
import { ApiError } from "../../lib/api";
import { metricFormatter } from "../../lib/format";
import { METRICS, unitClassOf, type BarGaugeConfig, type StatConfig, type StateTimelineConfig, type TableConfig } from "../../lib/layout";
import { COLLECTION_LABEL, reduceValues, thresholdColor, useCollection, useStates, type CollectionRow, type StateSegment } from "../../lib/panels";
import { useRefresh } from "../../lib/refresh";
import { seriesName } from "../charts/panelData";
import { Card } from "../ui";
import { defaultTitle, fetchSeries } from "./chartSource";

const metricName = (key: string) => (METRICS[key] ? t(METRICS[key].label) : key);
const chartColor = (n: number) => `var(--chart-${n})`;

function Shell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card className="flex flex-col p-4">
      <h2 className="mb-2 truncate text-sm font-medium">{title}</h2>
      {children}
    </Card>
  );
}

const Status = ({ children, alert = false }: { children: ReactNode; alert?: boolean }) => (
  <p role={alert ? "alert" : "status"} className={`py-6 text-center text-sm ${alert ? "text-danger" : "text-text-2"}`}>
    {children}
  </p>
);

// --- liczba z mini-wykresem -------------------------------------------------------------------

/** Mini-wykres: linia z wypełnieniem, skalowana do własnego minimum i maksimum. */
function Sparkline({ values, color }: { values: (number | null)[]; color: string }) {
  const nums = values.filter((v): v is number => v != null);
  if (nums.length < 2) return null;
  const min = Math.min(...nums);
  const span = Math.max(...nums) - min || 1;
  const pts = values
    .map((v, i) => (v == null ? null : `${((i / (values.length - 1)) * 100).toFixed(2)},${(38 - ((v - min) / span) * 34).toFixed(2)}`))
    .filter(Boolean)
    .join(" ");
  return (
    <svg viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-12 w-full">
      <polygon points={`0,40 ${pts} 100,40`} fill={color} opacity={0.15} />
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function statTitle(c: StatConfig): string {
  return c.title || `${defaultTitle(c.source)}: ${seriesName(c.source, { key: c.key })}`;
}

export function StatWidget({ config }: { config: StatConfig }) {
  const global = useRefresh();
  const minutes = config.range_min ?? global.rangeMinutes;
  const own = config.refresh_s;
  const query = useQuery({
    queryKey: ["chart", config.source, minutes, 0],
    queryFn: () => fetchSeries(config.source, minutes),
    refetchInterval: own == null ? global.refetchInterval : own > 0 ? own * 1000 : false,
    placeholderData: (previous) => previous,
    retry: false,
  });
  const values = useMemo(() => (query.data?.points ?? []).map((p) => p.values[config.key] ?? null), [query.data, config.key]);
  const value = reduceValues(values, config.reduce);
  const format = metricFormatter(unitClassOf(config.key), config.unit);
  const color = chartColor(thresholdColor(value, config.thresholds, config.color));
  const background = config.color_mode === "background" && value != null;
  const title = statTitle(config);
  return (
    <Card className="flex flex-col overflow-hidden">
      <div
        className="relative flex min-h-32 flex-1 flex-col p-4"
        style={background ? { background: `color-mix(in srgb, ${color} 22%, var(--surface))` } : undefined}
      >
      <h2 className="truncate text-sm font-medium">{title}</h2>
      {query.isError && !query.data ? (
        <Status alert>{query.error instanceof ApiError && query.error.status === 404 ? t("chart.sourceGone") : t("chart.error")}</Status>
      ) : query.isLoading ? (
        <Status>{t("chart.loading")}</Status>
      ) : (
        <p className="relative z-10 mt-2 text-3xl font-semibold tabular-nums" style={{ color: background ? undefined : color }} aria-label={`${title}: ${value == null ? "–" : format(value)}`}>
          {value == null ? "–" : format(value)}
          {config.reduce !== "last" && <span className="ml-2 text-xs font-normal text-text-2">{t(`panel.reduce.${config.reduce}` as const)}</span>}
        </p>
      )}
      {config.sparkline && <Sparkline values={values} color={color} />}
      </div>
    </Card>
  );
}

// --- paski ------------------------------------------------------------------------------------

export function collectionTitle(kind: keyof typeof COLLECTION_LABEL, key?: string): string {
  return key ? `${t(COLLECTION_LABEL[kind])}: ${metricName(key)}` : t(COLLECTION_LABEL[kind]);
}

function useRows(config: { collection: BarGaugeConfig["collection"] }) {
  const query = useCollection(config.collection);
  const gone = query.error instanceof ApiError && query.error.status === 404;
  return { ...query, gone };
}

function sortRows(rows: CollectionRow[], key: string | null | undefined, desc: boolean): CollectionRow[] {
  if (!key) return desc ? [...rows].reverse() : rows;
  return [...rows].sort((a, b) => {
    const x = a.values[key];
    const y = b.values[key];
    if (x == null && y == null) return 0;
    if (x == null) return 1; // brak wartości zawsze na końcu
    if (y == null) return -1;
    return desc ? y - x : x - y;
  });
}

export function BarGaugeWidget({ config }: { config: BarGaugeConfig }) {
  const query = useRows(config);
  const cls = unitClassOf(config.key);
  const format = metricFormatter(cls, config.unit);
  const rows = useMemo(() => {
    const list = config.sort === "none" ? (query.data ?? []) : sortRows(query.data ?? [], config.key, config.sort === "desc");
    return list.slice(0, config.limit);
  }, [query.data, config.sort, config.key, config.limit]);
  const values = rows.map((r) => r.values[config.key]).filter((v): v is number => v != null);
  const max = config.max ?? (cls === "percent" ? 100 : Math.max(config.min + 1e-9, ...values));
  const pct = (v: number | null | undefined) => (v == null ? 0 : Math.min(100, Math.max(0, ((v - config.min) / (max - config.min)) * 100)));
  const title = config.title || collectionTitle(config.collection.kind, config.key);
  const vertical = config.orientation === "vertical";

  return (
    <Shell title={title}>
      {query.isError ? (
        <Status alert>{query.gone ? t("panel.gone") : t("chart.error")}</Status>
      ) : query.isLoading ? (
        <Status>{t("chart.loading")}</Status>
      ) : rows.length === 0 ? (
        <Status>{t("panel.empty")}</Status>
      ) : (
        <ul aria-label={title} className={vertical ? "flex min-h-40 flex-1 items-end gap-2" : "flex flex-col gap-2"}>
          {rows.map((r) => {
            const v = r.values[config.key];
            const color = chartColor(thresholdColor(v, config.thresholds, config.color));
            const text = v == null ? "–" : format(v);
            const meter = {
              role: "meter",
              "aria-label": r.label,
              "aria-valuemin": config.min,
              "aria-valuemax": max,
              "aria-valuenow": v ?? undefined,
              "aria-valuetext": text,
            } as const;
            return vertical ? (
              <li key={r.key} className="flex h-full min-w-0 flex-1 flex-col items-center gap-1 text-xs">
                <span className="font-medium tabular-nums" style={{ color }}>
                  {text}
                </span>
                <div {...meter} className="relative w-full flex-1 overflow-hidden rounded bg-surface-2">
                  <div className="absolute inset-x-0 bottom-0 rounded" style={{ height: `${pct(v)}%`, backgroundColor: color }} />
                </div>
                <span className="w-full truncate text-center text-text-2" title={r.label}>
                  {r.label}
                </span>
              </li>
            ) : (
              <li key={r.key} className="flex items-center gap-3 text-xs">
                <span className="w-28 shrink-0 truncate text-text-2" title={r.label}>
                  {r.label}
                </span>
                <div {...meter} className="relative h-3 flex-1 overflow-hidden rounded bg-surface-2">
                  <div className="absolute inset-y-0 left-0 rounded" style={{ width: `${pct(v)}%`, backgroundColor: color }} />
                </div>
                <span className="w-20 shrink-0 text-right font-medium tabular-nums" style={{ color }}>
                  {text}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Shell>
  );
}

// --- tabela -----------------------------------------------------------------------------------

function StateBadge({ up }: { up: boolean }) {
  return <span className={`rounded-md px-2 py-0.5 text-xs ${up ? "bg-success-soft text-success" : "bg-danger-soft text-danger"}`}>{t(up ? "panel.state.up" : "panel.state.down")}</span>;
}

export function TableWidget({ config }: { config: TableConfig }) {
  const query = useRows(config);
  const [sort, setSort] = useState<{ by: string | null; desc: boolean }>({ by: config.sort_by ?? null, desc: config.sort_desc });
  const rows = useMemo(() => {
    const list = query.data ?? [];
    const sorted = sort.by ? sortRows(list, sort.by, sort.desc) : [...list].sort((a, b) => a.label.localeCompare(b.label, "pl") * (sort.desc ? -1 : 1));
    return sorted.slice(0, config.limit);
  }, [query.data, sort, config.limit]);
  const title = config.title || collectionTitle(config.collection.kind);
  const header = (key: string | null, label: string, right: boolean) => {
    const active = sort.by === key;
    return (
      <th scope="col" aria-sort={active ? (sort.desc ? "descending" : "ascending") : "none"} className={`py-2 font-medium ${right ? "pl-3 text-right" : "pr-3"}`}>
        <button type="button" onClick={() => setSort((s) => ({ by: key, desc: s.by === key ? !s.desc : key !== null }))} className="inline-flex items-center gap-1 hover:text-text">
          {label}
          {active && (sort.desc ? <IconArrowDown size={12} aria-hidden="true" /> : <IconArrowUp size={12} aria-hidden="true" />)}
        </button>
      </th>
    );
  };
  return (
    <Shell title={title}>
      {query.isError ? (
        <Status alert>{query.gone ? t("panel.gone") : t("chart.error")}</Status>
      ) : query.isLoading ? (
        <Status>{t("chart.loading")}</Status>
      ) : rows.length === 0 ? (
        <Status>{t("panel.empty")}</Status>
      ) : (
        <div className="-mx-1 overflow-x-auto px-1">
          <table aria-label={title} className="w-full text-left text-sm">
            <thead className="text-xs text-text-2">
              <tr>
                {header(null, t("panel.table.name"), false)}
                {config.columns.map((c) => (
                  <Fragment key={c}>{header(c, metricName(c), true)}</Fragment>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className="border-t border-border">
                  <td className="max-w-48 truncate py-1.5 pr-3" title={r.label}>
                    {r.label}
                  </td>
                  {config.columns.map((c) => {
                    const v = r.values[c];
                    const cls = unitClassOf(c);
                    return (
                      <td key={c} className="py-1.5 pl-3 text-right tabular-nums">
                        {v == null ? "–" : cls === "state" ? <StateBadge up={v >= 0.5} /> : metricFormatter(cls, config.unit)(v)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Shell>
  );
}

// --- oś stanów --------------------------------------------------------------------------------

const BAND: Record<StateSegment["state"], string> = { up: "bg-success", down: "bg-danger", unknown: "bg-surface-2" };
const STATE_LABEL = { up: "panel.state.up", down: "panel.state.down", unknown: "panel.state.unknown" } as const;
const timeFmt = new Intl.DateTimeFormat("pl", { dateStyle: "short", timeStyle: "short" });

export function stateTimelineTitle(c: StateTimelineConfig): string {
  return c.title || t("widget.type.state_timeline");
}

export function StateTimelineWidget({ config }: { config: StateTimelineConfig }) {
  const query = useStates(config.items, config.range_min, config.refresh_s);
  const title = stateTimelineTitle(config);
  const data = query.data;
  const from = data ? new Date(data.start).getTime() : 0;
  const span = data ? Math.max(1, new Date(data.end).getTime() - from) : 1;
  const pct = (iso: string) => Math.min(100, Math.max(0, ((new Date(iso).getTime() - from) / span) * 100));
  return (
    <Shell title={title}>
      {query.isError && !data ? (
        <Status alert>{t("chart.error")}</Status>
      ) : !data ? (
        <Status>{t("chart.loading")}</Status>
      ) : data.items.length === 0 ? (
        <Status>{t("panel.empty")}</Status>
      ) : (
        <div className="flex flex-col gap-1.5">
          {data.items.map((item) => (
            <div key={`${item.kind}${item.id}`} className="flex items-center gap-3 text-xs">
              <span className="w-32 shrink-0 truncate text-text-2" title={item.label}>
                {item.label}
              </span>
              <div role="list" aria-label={t("panel.state.band", { name: item.label })} className="relative h-4 flex-1 overflow-hidden rounded bg-surface-2">
                {item.segments.map((s) => {
                  const left = pct(s.start);
                  const label = `${t(STATE_LABEL[s.state])}: ${timeFmt.format(new Date(s.start))} – ${timeFmt.format(new Date(s.end))}`;
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
          ))}
          <div className="mt-1 flex flex-wrap items-center justify-between gap-2 pl-35 text-xs text-text-2">
            <span>{timeFmt.format(new Date(data.start))}</span>
            <span className="flex gap-3">
              {(["up", "down", "unknown"] as const).map((s) => (
                <span key={s} className="inline-flex items-center gap-1">
                  <span aria-hidden="true" className={`inline-block size-2.5 rounded-sm ${BAND[s]}`} />
                  {t(STATE_LABEL[s])}
                </span>
              ))}
            </span>
            <span>{timeFmt.format(new Date(data.end))}</span>
          </div>
        </div>
      )}
    </Shell>
  );
}
