import { IconFileSpreadsheet, IconPhoto } from "@tabler/icons-react";
import type * as echarts from "echarts/core";
import { lazy, Suspense, useContext, useMemo, useRef, useState } from "react";
import { t } from "../../i18n";
import { ApiError, type Series } from "../../lib/api";
import { formatRange, metricFormatter } from "../../lib/format";
import { useChartEvents } from "../../lib/events";
import { useDetailLinks } from "../../lib/publicMode";
import { DEFAULT_LEGEND, axisClass, upgradeChartConfig, type ChartConfig, type LegacyChartConfig } from "../../lib/layout";
import { ChartLegend, type LegendItem } from "../charts/ChartLegend";
import { buildLines, lineStats, linesToCsv } from "../charts/panelData";
import { download, fileName } from "../../lib/download";
import { GridCellContext } from "../DashboardGrid";
import { Card } from "../ui";
import { defaultTitle, useChartQueries } from "./chartSource";
import { WidgetActions, type WidgetAction } from "./WidgetActions";

// ECharts jest duży – ładowany dopiero, gdy wykres jest na ekranie
const PanelChart = lazy(() => import("../charts/PanelChart"));

const HEIGHT = { sm: 180, md: 240, lg: 340 } as const;

export function chartTitle(config: ChartConfig | LegacyChartConfig): string {
  const c = upgradeChartConfig(config);
  return c.title || defaultTitle(c.queries[0].source);
}

const loading = (
  <p role="status" className="py-10 text-center text-sm text-text-2">
    {t("chart.loading")}
  </p>
);

/** Wykres w czasie skonfigurowany w widgecie: zapytania (źródła), osie, progi, legenda, zakres i odświeżanie.
 * Od 0.40.0 bez trybu „Na żywo” – dane na żywo pokazują tylko wykresy kołowe. */
export function ChartWidget({ config: raw, className = "" }: { config: ChartConfig | LegacyChartConfig; className?: string }) {
  const config = useMemo(() => upgradeChartConfig(raw), [raw]);
  // W komórce siatki pulpitu wykres wypełnia wysokość komórki; poza nią (strony szczegółów) – wysokość z konfiguracji
  const fill = useContext(GridCellContext);
  const first = config.queries[0];

  const result = useChartQueries(config);
  // Zdarzenia tylko w zalogowanym panelu (pulpit publiczny nie dostaje historii alertów) i bez trybu „Na żywo”
  const events = useChartEvents(config, useDetailLinks());
  const bucketMs = (result.queries.find((q) => q.data)?.data?.interval_s ?? 30) * 1000;
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setHidden((h) => {
      const next = new Set(h);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const byQuery = useMemo(() => {
    return new Map<string, Series | undefined>(result.queries.map((q) => [q.query.id, q.data]));
  }, [result.queries]);
  const lines = useMemo(() => buildLines(config, byQuery, defaultTitle), [config, byQuery]);
  const leftFormat = useMemo(() => metricFormatter(axisClass(config, "left") ?? axisClass(config, "right") ?? "count", config.unit), [config]);
  const rightCls = axisClass(config, "right");
  const rightFormat = useMemo(() => (rightCls ? metricFormatter(rightCls, config.unit) : null), [rightCls, config.unit]);
  const legendItems: LegendItem[] = useMemo(
    () =>
      lines.map((line) => ({
        line,
        stats: lineStats(line.rows),
        format: line.axis === "right" && rightFormat ? rightFormat : leftFormat,
        hidden: hidden.has(line.id),
      })),
    [lines, hidden, leftFormat, rightFormat],
  );

  const visible = useMemo(() => lines.filter((l) => !hidden.has(l.id)), [lines, hidden]);
  const axes = config.axes ?? {};
  const left = useMemo(() => ({ format: leftFormat, min: axes.left?.min, max: axes.left?.max, label: axes.left?.label }), [leftFormat, axes.left]);
  const right = useMemo(
    () => (rightFormat && visible.some((l) => l.axis === "right") ? { format: rightFormat, min: axes.right?.min, max: axes.right?.max, label: axes.right?.label } : null),
    [rightFormat, visible, axes.right],
  );

  const title = config.title || defaultTitle(first.source);
  const gone = result.error instanceof ApiError && result.error.status === 404;
  const isLoading = result.isLoading && lines.every((l) => l.rows.length === 0);
  const isError = result.isError;
  const empty = !isLoading && !isError && lines.every((l) => l.rows.length === 0);
  const legend = config.legend ?? DEFAULT_LEGEND;
  const instance = useRef<echarts.ECharts | null>(null);
  const hasData = !isLoading && !isError && !empty;
  const exports: WidgetAction[] = hasData
    ? [
        { label: t("chart.export.csv"), icon: IconFileSpreadsheet, onClick: () => download(fileName(title, "csv"), new Blob([linesToCsv(lines, t("chart.export.time"))], { type: "text/csv;charset=utf-8" })) },
        {
          label: t("chart.export.png"),
          icon: IconPhoto,
          onClick: () => {
            const url = instance.current?.getDataURL({ type: "png", pixelRatio: 2, backgroundColor: getComputedStyle(document.documentElement).getPropertyValue("--surface").trim() });
            if (url) download(fileName(title, "png"), url);
          },
        },
      ]
    : [];
  const legendRight = legend.placement === "right" && legend.mode !== "hidden";

  return (
    <Card className={`p-4 ${fill ? "flex h-full min-h-0 flex-col" : ""} ${className}`}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="truncate text-sm font-medium">{title}</h2>
        <div className="flex shrink-0 items-center gap-1">
          <WidgetActions actions={exports} />
        </div>
      </div>
      {isError ? (
        <p role="alert" className="py-10 text-center text-sm text-danger">
          {gone ? t("chart.sourceGone") : t("chart.error")}
        </p>
      ) : empty ? (
        <p className="py-10 text-center text-sm text-text-2">{t("chart.empty")}</p>
      ) : isLoading ? (
        loading
      ) : (
        <div className={`${legendRight ? "flex flex-col gap-3 lg:flex-row" : "flex flex-col gap-2"} ${fill ? "min-h-0 flex-1" : ""}`}>
          <div className={`min-w-0 flex-1 ${fill ? "min-h-24" : ""}`}>
            <Suspense fallback={loading}>
              <PanelChart
                lines={visible}
                kind={config.chart}
                stack={config.stack ?? false}
                smooth={config.smooth}
                left={left}
                right={right}
                thresholds={config.thresholds ?? []}
                thresholdStyle={config.threshold_style ?? "line"}
                height={fill ? "100%" : HEIGHT[config.height]}
                ariaLabel={t("chart.summary", { title, range: formatRange(result.minutes) })}
                instanceRef={instance}
                events={events}
                bucketMs={bucketMs}
              />
            </Suspense>
          </div>
          <div className={`${legendRight ? "lg:w-64 lg:shrink-0" : ""} ${fill ? "max-h-[45%] shrink-0 overflow-y-auto" : ""}`}>
            <ChartLegend items={legendItems} config={legend} onToggle={toggle} />
          </div>
        </div>
      )}
    </Card>
  );
}
