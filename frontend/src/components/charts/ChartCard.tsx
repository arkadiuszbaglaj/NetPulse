import { lazy, Suspense, type ReactNode } from "react";
import { t } from "../../i18n";
import type { Series } from "../../lib/api";
import { formatRange } from "../../lib/format";
import { useRefresh } from "../../lib/refresh";
import { Card } from "../ui";
import type { ChartSeries } from "./TimeSeriesChart";

// ECharts jest duży – ładowany dopiero po wejściu na pulpit, nie na ekranie logowania
const TimeSeriesChart = lazy(() => import("./TimeSeriesChart"));

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
  /** Wysokość wykresu w pikselach */
  height?: number;
  /** Wykres wypełnia resztę wysokości karty (komórka siatki pulpitu) zamiast `height` */
  fill?: boolean;
  /** Treść błędu zamiast domyślnej (np. „źródło niedostępne”) */
  errorText?: string;
  /** Przyciski po prawej stronie tytułu */
  actions?: ReactNode;
  /** Dodatkowa treść pod tytułem (np. bieżące wartości) */
  children?: ReactNode;
}

/** Karta z wykresem: tytuł, stany ładowania, błędu i braku danych. */
export function ChartCard({
  title,
  series,
  data,
  isLoading,
  isError,
  format,
  className = "",
  rangeMinutes,
  kind,
  smooth,
  yMax,
  height,
  fill = false,
  errorText,
  actions,
  children,
}: ChartCardProps) {
  const global = useRefresh();
  const range = rangeMinutes ?? global.rangeMinutes;
  const empty = !isLoading && !isError && (data?.points.length ?? 0) === 0;
  return (
    <Card className={`p-4 ${fill ? "flex h-full min-h-0 flex-col" : ""} ${className}`}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="truncate text-sm font-medium">{title}</h2>
        {actions}
      </div>
      {children}
      {isError && !data ? (
        <p role="alert" className="py-10 text-center text-sm text-danger">
          {errorText ?? t("chart.error")}
        </p>
      ) : empty ? (
        <p className="py-10 text-center text-sm text-text-2">{t("chart.empty")}</p>
      ) : isLoading || !data ? (
        <p role="status" className="py-10 text-center text-sm text-text-2">
          {t("chart.loading")}
        </p>
      ) : (
        <div className={fill ? "min-h-24 flex-1" : ""}>
          <Suspense
            fallback={
              <p role="status" className="py-10 text-center text-sm text-text-2">
                {t("chart.loading")}
              </p>
            }
          >
            <TimeSeriesChart
              series={series}
              points={data.points}
              intervalS={data.interval_s}
              format={format}
              kind={kind}
              smooth={smooth}
              yMax={yMax}
              height={fill ? "100%" : height}
              ariaLabel={t("chart.summary", { title, range: formatRange(range) })}
            />
          </Suspense>
        </div>
      )}
    </Card>
  );
}
