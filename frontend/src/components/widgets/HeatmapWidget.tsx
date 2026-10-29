/** Mapa cieplna (0.37.0): kiedy sieć (albo serwer) jest najbardziej obciążona – godzina × dzień tygodnia albo data. */
import { useQueries } from "@tanstack/react-query";
import { useContext, useMemo, useState } from "react";
import { t } from "../../i18n";
import { ApiError, type SeriesPoint } from "../../lib/api";
import { metricFormatter } from "../../lib/format";
import { HEATMAP_WEEK, heatmapGrid, intensity } from "../../lib/heatmap";
import { unitClassOf, type HeatmapConfig } from "../../lib/layout";
import { useRefresh } from "../../lib/refresh";
import { seriesName } from "../charts/panelData";
import { GridCellContext } from "../DashboardGrid";
import { Card } from "../ui";
import { defaultTitle, fetchSeries } from "./chartSource";
import { WidgetActions } from "./WidgetActions";

const weekdayFmt = new Intl.DateTimeFormat("pl", { weekday: "short" });
const dateFmt = new Intl.DateTimeFormat("pl", { day: "2-digit", month: "2-digit" });
// 2 listopada 2026 to poniedziałek – nazwy dni od poniedziałku
const WEEKDAYS = Array.from({ length: 7 }, (_, i) => weekdayFmt.format(new Date(2026, 10, 2 + i)));
const HOURS = Array.from({ length: 24 }, (_, h) => h);

export function heatmapTitle(c: HeatmapConfig): string {
  return c.title || `${defaultTitle(c.source)}: ${seriesName(c.source, { key: c.key })}`;
}

function rowLabel(key: string, group: HeatmapConfig["group"]): string {
  if (group === "weekday") return WEEKDAYS[Number(key)];
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return `${weekdayFmt.format(date)} ${dateFmt.format(date)}`;
}

/** Kolor kratki: od tła (brak ruchu) do koloru widgetu (największa wartość). */
const cellColor = (color: number, k: number) => `color-mix(in srgb, var(--chart-${color}) ${Math.round(8 + 92 * k)}%, var(--surface-2))`;

export function HeatmapWidget({ config }: { config: HeatmapConfig }) {
  const global = useRefresh();
  const fill = useContext(GridCellContext);
  // Tydzień po tygodniu: bieżący odświeżany jak reszta pulpitu, starsze się nie zmieniają
  const results = useQueries({
    queries: Array.from({ length: config.weeks }, (_, k) => {
      const back = k * HEATMAP_WEEK;
      return {
        queryKey: back ? ["chart", config.source, HEATMAP_WEEK, 0, back] : ["chart", config.source, HEATMAP_WEEK, 0],
        queryFn: () => fetchSeries(config.source, HEATMAP_WEEK, 0, back),
        refetchInterval: k === 0 ? global.refetchInterval : (false as const),
        staleTime: k === 0 ? 0 : Infinity,
        retry: false,
      };
    }),
  });
  const points = useMemo(() => results.flatMap((r) => r.data?.points ?? []) as SeriesPoint[], [results]);
  const days = config.weeks * 7;
  const grid = useMemo(() => heatmapGrid(points, config.key, config.group, config.reduce, days), [points, config.key, config.group, config.reduce, days]);
  const format = metricFormatter(unitClassOf(config.key), config.unit);
  const [picked, setPicked] = useState<string | null>(null);
  const title = heatmapTitle(config);
  const metric = seriesName(config.source, { key: config.key });
  const error = results.find((r) => r.isError)?.error;
  const loading = results.some((r) => r.isLoading);

  const label = (row: string, hour: number, v: number | null) =>
    `${rowLabel(row, config.group)}, ${String(hour).padStart(2, "0")}:00–${String(hour + 1).padStart(2, "0")}:00: ${v == null ? t("heatmap.nodata") : format(v)}`;

  return (
    <Card className={`flex flex-col p-4 ${fill ? "h-full min-h-0" : ""}`}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="truncate text-sm font-medium">{title}</h2>
        <WidgetActions />
      </div>
      {error && !points.length ? (
        <p role="alert" className="py-10 text-center text-sm text-danger">
          {error instanceof ApiError && error.status === 404 ? t("chart.sourceGone") : t("chart.error")}
        </p>
      ) : loading && !points.length ? (
        <p role="status" className="py-10 text-center text-sm text-text-2">
          {t("chart.loading")}
        </p>
      ) : (
        <>
          <div
            role="grid"
            aria-label={title}
            className={`grid gap-0.5 text-[10px] text-text-2 ${fill ? "min-h-0 flex-1 overflow-y-auto" : ""}`}
            style={{ gridTemplateColumns: "auto repeat(24, minmax(0, 1fr))", gridAutoRows: "minmax(14px, 1fr)" }}
          >
            <span aria-hidden="true" />
            {HOURS.map((h) => (
              <span key={h} aria-hidden="true" className="self-end text-center tabular-nums">
                {h % 3 === 0 ? h : ""}
              </span>
            ))}
            {grid.rows.map((row) => (
              <div key={row.key} role="row" className="contents">
                <span role="rowheader" className="self-center pr-1.5 whitespace-nowrap">
                  {rowLabel(row.key, config.group)}
                </span>
                {row.cells.map((v, h) => {
                  const id = `${row.key}-${h}`;
                  const text = label(row.key, h, v);
                  return (
                    <button
                      key={h}
                      type="button"
                      role="gridcell"
                      aria-label={text}
                      title={text}
                      aria-pressed={picked === id}
                      onClick={() => setPicked((p) => (p === id ? null : id))}
                      className={`min-h-3.5 rounded-[3px] focus-visible:ring-2 focus-visible:ring-text focus-visible:outline-none ${picked === id ? "ring-2 ring-text" : ""}`}
                      style={{ background: v == null ? "var(--surface-2)" : cellColor(config.color, intensity(v, grid.min, grid.max)), opacity: v == null ? 0.5 : 1 }}
                    />
                  );
                })}
              </div>
            ))}
          </div>
          <div className="mt-2 flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-text-2">
            <span>
              {picked
                ? (() => {
                    const [row, h] = [picked.slice(0, picked.lastIndexOf("-")), Number(picked.slice(picked.lastIndexOf("-") + 1))];
                    return label(row, h, grid.rows.find((r) => r.key === row)?.cells[h] ?? null);
                  })()
                : t(config.reduce === "max" ? "heatmap.summary.max" : "heatmap.summary.avg", { metric: metric.toLowerCase(), weeks: config.weeks })}
            </span>
            {grid.min != null && grid.max != null && (
              <span className="inline-flex items-center gap-1.5 tabular-nums">
                {format(grid.min)}
                <span aria-hidden="true" className="inline-block h-2 w-20 rounded-sm" style={{ background: `linear-gradient(to right, ${cellColor(config.color, 0)}, ${cellColor(config.color, 1)})` }} />
                {format(grid.max)}
              </span>
            )}
          </div>
        </>
      )}
    </Card>
  );
}
