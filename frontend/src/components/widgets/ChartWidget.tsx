import { useMemo } from "react";
import { t } from "../../i18n";
import { ApiError } from "../../lib/api";
import { metricFormatter } from "../../lib/format";
import { METRICS, unitClassOf, type ChartConfig, type SeriesConfig, type Source } from "../../lib/layout";
import { ChartCard } from "../charts/ChartCard";
import type { ChartSeries } from "../charts/TimeSeriesChart";
import { defaultTitle, useChartSeries } from "./chartSource";

const HEIGHT = { sm: 180, md: 240, lg: 340 } as const;

/** Nazwa serii: własna etykieta, dla WAN „Pobieranie/Wysyłanie” (perspektywa użytkownika), inaczej nazwa metryki. */
function seriesName(source: Source, s: SeriesConfig): string {
  if (s.label) return s.label;
  if (source.kind === "wan") {
    if (s.key === "in_bps") return t("chart.traffic.in");
    if (s.key === "out_bps") return t("chart.traffic.out");
  }
  const meta = METRICS[s.key];
  return meta ? t(meta.label) : s.key;
}

export function chartSeriesOf(config: ChartConfig): ChartSeries[] {
  return config.series.map((s, i) => ({
    key: s.key,
    name: seriesName(config.source, s),
    color: ((s.color ?? ((i % 4) + 1)) as 1 | 2 | 3 | 4),
  }));
}

/** Wykres skonfigurowany w widgecie: źródło, serie, typ, jednostki, zakres i odświeżanie. */
export function ChartWidget({ config, className = "" }: { config: ChartConfig; className?: string }) {
  const { data, isLoading, isError, error, minutes } = useChartSeries(config);
  const series = useMemo(() => chartSeriesOf(config), [config]);
  const format = useMemo(
    () => metricFormatter(unitClassOf(config.series[0]?.key ?? ""), config.unit),
    [config.series, config.unit],
  );
  const gone = error instanceof ApiError && error.status === 404;
  return (
    <ChartCard
      className={className}
      title={config.title || defaultTitle(config.source)}
      series={series}
      data={data}
      isLoading={isLoading}
      isError={isError}
      errorText={gone ? t("chart.sourceGone") : undefined}
      format={format}
      rangeMinutes={minutes}
      kind={config.chart}
      smooth={config.smooth}
      yMax={config.y_max}
      height={HEIGHT[config.height]}
    />
  );
}
