import { IconFileSpreadsheet, IconPhoto } from "@tabler/icons-react";
import type * as echarts from "echarts/core";
import { lazy, Suspense, useContext, useMemo, useRef, useState } from "react";
import { t } from "../../i18n";
import { ApiError, type Series } from "../../lib/api";
import { formatRange, metricFormatter } from "../../lib/format";
import { DEFAULT_LEGEND, NO_THRESHOLDS, axisClass, upgradeChartConfig, type ChartConfig, type LegacyChartConfig } from "../../lib/layout";
import { ChartLegend, type LegendItem } from "../charts/ChartLegend";
import { fitLegend, rightLegendWidth, useBoxSize } from "../charts/legendFit";
import { backupSpans, buildLines, lineStats, linesToCsv } from "../charts/panelData";
import { download, fileName } from "../../lib/download";
import { GridCellContext } from "../DashboardGrid";
import { useLiveDeviceSample, liveValue } from "../../lib/liveHub";
import { useLiveWan } from "../../lib/liveWan";
import { useWanHistory } from "../../lib/wan";
import { LiveBadge } from "../LiveBadge";
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
  // Od 0.55.0: kiedy internet szedł łączem zapasowym – te odcinki serii innym kolorem
  const wanHistory = useWanHistory(result.minutes, config.wan_backup ?? false);
  const backup = useMemo(() => (config.wan_backup ? backupSpans(wanHistory.data) : []), [config.wan_backup, wanHistory.data]);
  const backupShown = backup.some(([, to]) => to >= Date.now() - result.minutes * 60_000);
  // Zdarzenia tylko w zalogowanym panelu (pulpit publiczny nie dostaje historii alertów) i bez trybu „Na żywo”
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
  // W komórce siatki legenda ustępuje miejsca wykresowi, gdy karta jest mała (od 0.53.0, `legendFit.ts`)
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  const box = useBoxSize(body, fill);
  const configured = config.legend ?? DEFAULT_LEGEND;
  const legend = fill ? fitLegend(configured, lines.length, box) : configured;
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
  // Bieżąca wartość pierwszej widocznej serii w nagłówku karty (od 0.43.0) – bez porównań z przeszłością
  // Przy stosie – suma ostatnich wartości warstw (pierwsza warstwa sama w sobie myli)
  const current = hasData ? legendItems.filter((i) => !i.hidden && !i.line.dashed && i.stats.last != null) : [];
  const lead = current[0];
  const stacked = (config.stack ?? false) && current.length > 1;
  const stackTotal = stacked ? current.filter((i) => i.line.axis === lead.line.axis).reduce((sum, i) => sum + (i.stats.last ?? 0), 0) : null;
  // Bieżąca wartość z kanału na żywo (0.45.0): WAN, port i CPU/RAM urządzenia SNMP; historia wykresu – z bazy
  const leadQuery = lead ? config.queries.find((q) => q.id === lead.line.id.split(".")[0]) : undefined;
  const leadKey = lead?.line.id.split(".").slice(1).join(".");
  const src = leadQuery?.source;
  const liveDevice = src?.kind === "interface" ? (src.device_id ?? null) : src?.kind === "device" ? src.id : null;
  const liveWan = useLiveWan(!stacked && src?.kind === "wan");
  const liveDev = useLiveDeviceSample(liveDevice, !stacked && liveDevice != null);
  const liveNow =
    stacked || !src || !leadKey
      ? null
      : src.kind === "wan"
        ? leadKey === "in_bps" ? (liveWan?.in_bps ?? null) : leadKey === "out_bps" ? (liveWan?.out_bps ?? null) : null
        : src.kind === "interface" && (leadKey === "in_bps" || leadKey === "out_bps")
          ? liveValue(liveDev, (x) => x.ports.get(src.id)?.[leadKey])
          : src.kind === "device" && (leadKey === "cpu_percent" || leadKey === "mem_used_percent")
            ? liveValue(liveDev, (x) => x[leadKey])
            : null;
  const headline = !lead
    ? null
    : stackTotal != null
      ? { value: lead.format(stackTotal), label: t("chart.total"), live: false }
      : { value: lead.format(liveNow ?? lead.stats.last ?? 0), label: lead.line.name, live: liveNow != null };

  return (
    <Card className={`p-4 ${fill ? "flex h-full min-h-0 flex-col" : ""} ${className}`}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <h2 className="min-w-0 truncate pt-0.5 text-[15px] font-semibold">{title}</h2>
        <div className="flex shrink-0 items-start gap-2">
          {headline && (
            <p className="text-right leading-tight" title={headline.label}>
              <span className="block text-xl font-semibold tracking-tight">{headline.value}</span>
              <span className="flex max-w-40 items-center justify-end gap-1.5 truncate text-[11px] text-muted">
                {headline.live && <LiveBadge compact />}
                {headline.label}
              </span>
            </p>
          )}
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
        <div
          ref={setBody}
          className={`${legendRight ? (fill ? "flex flex-row gap-3" : "flex flex-col gap-3 lg:flex-row") : "flex flex-col gap-2"} ${fill ? "min-h-0 flex-1" : ""}`}
        >
          <div className={`min-w-0 flex-1 ${fill ? "min-h-16" : ""}`}>
            <Suspense fallback={loading}>
              <PanelChart
                lines={visible}
                kind={config.chart}
                stack={config.stack ?? false}
                smooth={config.smooth}
                left={left}
                right={right}
                thresholds={config.thresholds ?? NO_THRESHOLDS}
                thresholdStyle={config.threshold_style ?? "line"}
                height={fill ? "100%" : HEIGHT[config.height]}
                ariaLabel={t("chart.summary", { title, range: formatRange(result.minutes) })}
                instanceRef={instance}
                backup={backup}
              />
            </Suspense>
          </div>
          <div
            className={legendRight ? (fill ? "shrink-0 overflow-y-auto" : "lg:w-64 lg:shrink-0") : fill ? "max-h-[45%] shrink-0 overflow-y-auto" : ""}
            style={legendRight && fill ? { width: rightLegendWidth(legend) } : undefined}
          >
            {backupShown && legend.mode !== "hidden" && (
              <p className="mb-1 flex items-center gap-1.5 px-1 text-xs text-text-2">
                <span aria-hidden="true" className="inline-block h-1 w-3.5 rounded-full" style={{ backgroundColor: "var(--chart-backup)" }} />
                {t("chart.wanBackup")}
              </p>
            )}
            <ChartLegend items={legendItems} config={legend} onToggle={toggle} />
          </div>
        </div>
      )}
    </Card>
  );
}
