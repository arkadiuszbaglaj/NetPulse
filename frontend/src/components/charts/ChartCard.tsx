import { lazy, Suspense } from "react";
import { t } from "../../i18n";
import type { Series } from "../../lib/api";
import { formatRange } from "../../lib/format";
import { useRefresh } from "../../lib/refresh";
import { Card } from "../ui";
import type { ChartSeries } from "./TimeSeriesChart";

// ECharts jest duży – ładowany dopiero po wejściu na pulpit, nie na ekranie logowania
const TimeSeriesChart = lazy(() => import("./TimeSeriesChart"));

interface ChartCardProps {
  title: string;
  series: ChartSeries[];
  data: Series | undefined;
  isLoading: boolean;
  isError: boolean;
  format: (value: number) => string;
  className?: string;
}

/** Karta z wykresem: tytuł, stany ładowania, błędu i braku danych. */
export function ChartCard({ title, series, data, isLoading, isError, format, className = "" }: ChartCardProps) {
  const { rangeMinutes } = useRefresh();
  const empty = !isLoading && !isError && (data?.points.length ?? 0) === 0;
  return (
    <Card className={`p-4 ${className}`}>
      <h2 className="mb-2 text-sm font-medium">{title}</h2>
      {isError && !data ? (
        <p role="alert" className="py-10 text-center text-sm text-danger">
          {t("chart.error")}
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
            ariaLabel={t("chart.summary", { title, range: formatRange(rangeMinutes) })}
          />
        </Suspense>
      )}
    </Card>
  );
}
