import { IconBroadcast } from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import { t } from "../../i18n";
import { ApiError } from "../../lib/api";
import { formatBps, metricFormatter } from "../../lib/format";
import { useLiveWan } from "../../lib/live";
import { METRICS, autoColor, unitClassOf, type ChartConfig, type SeriesConfig, type Source } from "../../lib/layout";
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
    color: s.color ?? autoColor(i),
  }));
}

function LiveToggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors ${
        on ? "bg-accent-soft font-medium text-accent" : "text-text-2 hover:bg-surface-2 hover:text-text"
      }`}
    >
      <IconBroadcast size={14} aria-hidden="true" />
      {t("live.toggle")}
    </button>
  );
}

/** Wykres skonfigurowany w widgecie: źródło, serie, typ, jednostki, zakres i odświeżanie.
 * `allowLive` dodaje przełącznik „Na żywo” (tylko dla ruchu WAN). */
export function ChartWidget({ config, className = "", allowLive = false }: { config: ChartConfig; className?: string; allowLive?: boolean }) {
  const canLive = allowLive && config.source.kind === "wan";
  const [live, setLive] = useState(false);
  const stream = useLiveWan(live && canLive);
  const lost = live && stream.status === "lost";
  // Po utracie połączenia wracamy do zwykłego odświeżania i mówimy o tym użytkownikowi
  useEffect(() => {
    if (lost) setLive(false);
  }, [lost]);
  const [notice, setNotice] = useState(false);
  useEffect(() => {
    if (lost) setNotice(true);
    else if (live) setNotice(false);
  }, [lost, live]);

  const { data, isLoading, isError, error, minutes } = useChartSeries(config);
  const series = useMemo(() => chartSeriesOf(config), [config]);
  const format = useMemo(
    () => metricFormatter(unitClassOf(config.series[0]?.key ?? ""), config.unit),
    [config.series, config.unit],
  );
  const gone = error instanceof ApiError && error.status === 404;
  const showLive = live && canLive;
  const toggle = canLive ? <LiveToggle on={showLive} onClick={() => setLive((v) => !v)} /> : undefined;
  return (
    <ChartCard
      className={className}
      title={config.title || defaultTitle(config.source)}
      series={series}
      data={showLive ? stream.series : data}
      isLoading={showLive ? stream.status === "connecting" : isLoading}
      isError={showLive ? false : isError}
      errorText={gone ? t("chart.sourceGone") : undefined}
      format={format}
      rangeMinutes={showLive ? undefined : minutes}
      kind={config.chart}
      smooth={config.smooth}
      yMax={config.y_max}
      height={HEIGHT[config.height]}
      actions={toggle}
    >
      {showLive && stream.status === "live" && (
        <p className="mb-1 flex gap-4 text-lg font-medium" aria-live="off">
          <span>
            {t("chart.traffic.in")}: {formatBps(stream.current.in_bps)}
          </span>
          <span>
            {t("chart.traffic.out")}: {formatBps(stream.current.out_bps)}
          </span>
        </p>
      )}
      {notice && !showLive && (
        <p role="status" className="mb-1 text-xs text-danger">
          {t("live.lost")}
        </p>
      )}
    </ChartCard>
  );
}
