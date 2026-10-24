import { lazy, Suspense } from "react";
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
  /** Treść błędu zamiast domyślnej (np. „źródło niedostępne”) */
  errorText?: string;
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
  errorText,
}: ChartCardProps) {
  const global = useRefresh();
  const range = rangeMinutes ?? global.rangeMinutes;
  const empty = !isLoading && !isError && (data?.points.length ?? 0) === 0;
  return (
    <Card className={`p-4 ${className}`}>
      <h2 className="mb-2 truncate text-sm font-medium">{title}</h2>
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
            height={height}
            ariaLabel={t("chart.summary", { title, range: formatRange(range) })}
          />
        </Suspense>
      )}
    </Card>
  );
}
