/**
 * Karta z prostym wykresem w czasie (strony szczegółów, wykres aktywnego łącza WAN): seria = klucz z punktów API.
 * Od 0.36.0 rysuje ten sam silnik co widget „wykres” (PanelChart) – legenda z ukrywaniem serii, powiększanie,
 * wspólny kursor, menu „⋯” z eksportem CSV/PNG i pełnym ekranem na pulpicie.
 */
import { IconFileSpreadsheet, IconPhoto } from "@tabler/icons-react";
import type * as echarts from "echarts/core";
import { lazy, Suspense, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { t } from "../../i18n";
import type { Series } from "../../lib/api";
import { download, fileName } from "../../lib/download";
import type { ChartEvent } from "../../lib/events";
import { formatRange } from "../../lib/format";
import { autoColor, DEFAULT_LEGEND, type ColorIndex } from "../../lib/layout";
import { useRefresh } from "../../lib/refresh";
import { GridCellContext } from "../DashboardGrid";
import { Card } from "../ui";
import { WidgetActions, type WidgetAction } from "../widgets/WidgetActions";
import { ChartLegend, type LegendItem } from "./ChartLegend";
import { toChartRows } from "./chartData";
import { lineStats, linesToCsv, type PanelLine } from "./panelData";

// ECharts jest duży – ładowany dopiero, gdy wykres jest na ekranie
const PanelChart = lazy(() => import("./PanelChart"));

export interface ChartSeries {
  /** Klucz wartości w `points[].values` */
  key: string;
  name: string;
  /** Numer koloru z palety motywu (--chart-1…8); domyślnie kolejny */
  color?: ColorIndex;
}

export interface ChartCardProps {
  title: string;
  series: ChartSeries[];
  data: Series | undefined;
  isLoading: boolean;
  isError: boolean;
  format: (value: number) => string;
  className?: string;
  /** Zakres czasu widoczny w opisie wykresu; domyślnie globalny */
  rangeMinutes?: number;
  kind?: "line" | "area" | "bar";
  smooth?: boolean;
  yMax?: number | null;
  /** Wysokość wykresu w pikselach (poza komórką siatki pulpitu – tam wykres wypełnia komórkę) */
  height?: number;
  /** Treść błędu zamiast domyślnej (np. „źródło niedostępne”) */
  errorText?: string;
  /** Przyciski po prawej stronie tytułu */
  actions?: ReactNode;
  /** Dodatkowa treść pod tytułem (np. bieżące wartości) */
  children?: ReactNode;
  /** Zdarzenia na osi czasu (pionowe kreski) */
  events?: ChartEvent[];
}

const loading = (
  <p role="status" className="py-10 text-center text-sm text-text-2">
    {t("chart.loading")}
  </p>
);

/** Karta z wykresem: tytuł, stany ładowania, błędu i braku danych, legenda przy kilku seriach. */
export function ChartCard({
  title,
  series,
  data,
  isLoading,
  isError,
  format,
  className = "",
  rangeMinutes,
  kind = "area",
  smooth = false,
  yMax,
  height = 240,
  errorText,
  actions,
  children,
  events = [],
}: ChartCardProps) {
  const global = useRefresh();
  const range = rangeMinutes ?? global.rangeMinutes;
  const fill = useContext(GridCellContext);
  const instance = useRef<echarts.ECharts | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  const lines: PanelLine[] = useMemo(
    () =>
      series.map((s, i) => ({
        id: `A.${s.key}`,
        name: s.name,
        color: s.color ?? autoColor(i),
        axis: "left",
        rows: data ? toChartRows(data.points, s.key, data.interval_s) : [],
        dashed: false,
      })),
    [series, data],
  );
  const visible = useMemo(() => lines.filter((l) => !hidden.has(l.id)), [lines, hidden]);
  // Wartości ujemne (np. sygnał w dBm) – oś od danych, nie od zera
  const negative = lines.some((l) => l.rows.some(([, v]) => v != null && v < 0));
  const left = useMemo(() => ({ format, max: yMax ?? null, autoMin: negative }), [format, yMax, negative]);
  const legendItems: LegendItem[] = useMemo(
    () => lines.map((line) => ({ line, stats: lineStats(line.rows), format, hidden: hidden.has(line.id) })),
    [lines, hidden, format],
  );
  const toggle = (id: string) =>
    setHidden((h) => {
      const next = new Set(h);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const empty = !isLoading && !isError && (data?.points.length ?? 0) === 0;
  const ready = !!data && !(isError && !data) && !empty && !isLoading;
  const exports: WidgetAction[] = ready
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

  return (
    <Card className={`p-4 ${fill ? "flex h-full min-h-0 flex-col" : ""} ${className}`}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="truncate text-sm font-medium">{title}</h2>
        <div className="flex shrink-0 items-center gap-1">
          {actions}
          <WidgetActions actions={exports} />
        </div>
      </div>
      {children}
      {isError && !data ? (
        <p role="alert" className="py-10 text-center text-sm text-danger">
          {errorText ?? t("chart.error")}
        </p>
      ) : empty ? (
        <p className="py-10 text-center text-sm text-text-2">{t("chart.empty")}</p>
      ) : isLoading || !data ? (
        loading
      ) : (
        <div className={`flex flex-col gap-2 ${fill ? "min-h-0 flex-1" : ""}`}>
          <div className={`min-w-0 ${fill ? "min-h-24 flex-1" : ""}`}>
            <Suspense fallback={loading}>
              <PanelChart
                lines={visible}
                kind={kind}
                stack={false}
                smooth={smooth}
                left={left}
                right={null}
                thresholds={[]}
                thresholdStyle="off"
                height={fill ? "100%" : height}
                ariaLabel={t("chart.summary", { title, range: formatRange(range) })}
                instanceRef={instance}
                events={events}
                bucketMs={data.interval_s * 1000}
              />
            </Suspense>
          </div>
          {lines.length > 1 && (
            <div className={fill ? "max-h-[45%] shrink-0 overflow-y-auto" : ""}>
              <ChartLegend items={legendItems} config={DEFAULT_LEGEND} onToggle={toggle} />
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
