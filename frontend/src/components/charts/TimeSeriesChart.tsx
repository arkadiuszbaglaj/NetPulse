/**
 * Wykres szeregu czasowego (Apache ECharts). Ładowany leniwie – patrz ChartCard.
 * Konfiguracja serii jest w propsach, żeby edytor wykresów (etap 5e) mógł ją zmieniać bez zmian tutaj.
 */
import { LineChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { useEffect, useRef } from "react";
import type { SeriesPoint } from "../../lib/api";
import { autoColor, type ColorIndex } from "../../lib/layout";
import { useTheme } from "../../lib/theme";
import { toChartRows } from "./chartData";

echarts.use([LineChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer]);

export interface ChartSeries {
  /** Klucz wartości w `points[].values` */
  key: string;
  name: string;
  /** Numer koloru z palety motywu (--chart-1…8); domyślnie kolejny */
  color?: ColorIndex;
  area?: boolean;
}

export interface TimeSeriesChartProps {
  series: ChartSeries[];
  points: SeriesPoint[];
  /** Zapis wartości w osi i podpowiedzi, np. „42 Mb/s” */
  format: (value: number) => string;
  /** Odstęp między punktami w sekundach – dłuższa przerwa rysowana jest jako luka */
  intervalS: number;
  /** Rodzaj wykresu: linia, obszar (domyślnie) albo słupki */
  kind?: "line" | "area" | "bar";
  smooth?: boolean;
  /** Maksimum osi Y w jednostkach surowych metryki; puste = automatycznie */
  yMax?: number | null;
  /** Piksele albo "100%" (komórka siatki pulpitu) */
  height?: number | string;
  ariaLabel: string;
}

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const timeFmt = new Intl.DateTimeFormat("pl", { dateStyle: "short", timeStyle: "medium" });

export default function TimeSeriesChart({
  series,
  points,
  format,
  intervalS,
  kind = "area",
  smooth = false,
  yMax = null,
  height = 240,
  ariaLabel,
}: TimeSeriesChartProps) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const { resolved } = useTheme();

  useEffect(() => {
    if (!el.current) return;
    const instance = echarts.init(el.current, undefined, { renderer: "canvas" });
    chart.current = instance;
    const observer = new ResizeObserver(() => instance.resize());
    observer.observe(el.current);
    return () => {
      observer.disconnect();
      instance.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    const instance = chart.current;
    if (!instance) return;
    const text = css("--text-2");
    const grid = css("--border");
    const surface = css("--surface");

    instance.setOption(
      {
        animationDuration: 250,
        textStyle: { color: text },
        grid: { left: 8, right: 16, top: series.length > 1 ? 36 : 16, bottom: 8, containLabel: true },
        legend: series.length > 1 ? { top: 0, right: 0, textStyle: { color: text }, icon: "roundRect", itemHeight: 8 } : undefined,
        tooltip: {
          trigger: "axis",
          backgroundColor: surface,
          borderColor: grid,
          textStyle: { color: css("--text") },
          formatter: (params: { axisValue: number; marker: string; seriesName: string; value: [number, number | null] }[]) => {
            const head = timeFmt.format(new Date(params[0].axisValue));
            const rows = params
              .map((p) => `${p.marker} ${p.seriesName}: <b>${p.value[1] == null ? "–" : format(p.value[1])}</b>`)
              .join("<br/>");
            return `<div style="font-size:12px;color:${text}">${head}</div>${rows}`;
          },
        },
        xAxis: {
          type: "time",
          axisLine: { lineStyle: { color: grid } },
          // W wąskim wykresie etykiety osi nie mogą na siebie nachodzić
          axisLabel: { color: text, hideOverlap: true },
          splitNumber: 4,
          splitLine: { show: false },
        },
        yAxis: {
          type: "value",
          min: 0,
          max: yMax ?? undefined,
          axisLabel: { color: text, formatter: (v: number) => format(v) },
          splitLine: { lineStyle: { color: grid } },
        },
        series: series.map((s, i) => {
          const color = css(`--chart-${s.color ?? autoColor(i)}`);
          const data = toChartRows(points, s.key, intervalS);
          if (kind === "bar") {
            return { name: s.name, type: "bar", barMaxWidth: 14, itemStyle: { color }, data };
          }
          return {
            name: s.name,
            type: "line",
            smooth,
            showSymbol: false,
            symbol: "circle",
            symbolSize: 6,
            lineStyle: { width: 2, color },
            itemStyle: { color },
            areaStyle: kind === "area" && s.area !== false ? { color, opacity: 0.1 } : undefined,
            data,
          };
        }),
      },
      true,
    );
  }, [series, points, format, intervalS, kind, smooth, yMax, resolved]);

  return <div ref={el} role="img" aria-label={ariaLabel} style={{ height }} className="w-full" />;
}
