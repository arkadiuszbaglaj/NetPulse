/**
 * Wykres panelu (Apache ECharts): wiele serii z różnych źródeł, dwie osie Y, stos, progi. Ładowany leniwie.
 * Legenda jest poza płótnem (ChartLegend) – działa z klawiatury i czytnikiem ekranu.
 */
import { BarChart, LineChart } from "echarts/charts";
import { GridComponent, MarkAreaComponent, MarkLineComponent, TooltipComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { useEffect, useRef, type RefObject } from "react";
import type { ChartKind, Threshold, ThresholdStyle } from "../../lib/layout";
import type { ChartEvent, EventKind } from "../../lib/events";
import { t } from "../../i18n";
import { useRefresh } from "../../lib/refresh";
import { useTheme } from "../../lib/theme";
import { linkChart } from "./chartSync";
import { ZoomLayer } from "./ZoomLayer";
import type { ChartRow } from "./chartData";
import { leftTop, thresholdBands, type PanelLine } from "./panelData";

echarts.use([LineChart, BarChart, GridComponent, TooltipComponent, MarkLineComponent, MarkAreaComponent, CanvasRenderer]);

export interface AxisView {
  format: (value: number) => string;
  min?: number | null;
  max?: number | null;
  label?: string | null;
}

export interface PanelChartProps {
  lines: PanelLine[];
  kind: ChartKind;
  stack: boolean;
  smooth: boolean;
  left: AxisView;
  /** Oś prawa – tylko gdy jakaś widoczna seria jest na niej */
  right: AxisView | null;
  thresholds: Threshold[];
  thresholdStyle: ThresholdStyle;
  /** Piksele albo "100%" (komórka siatki pulpitu) */
  height: number | string;
  ariaLabel: string;
  /** Instancja ECharts dla właściciela (eksport do PNG) */
  instanceRef?: RefObject<echarts.ECharts | null>;
  /** Zdarzenia na osi czasu: pionowe kreski, opis w podpowiedzi przy kursorze w ich pobliżu */
  events?: ChartEvent[];
  /** Szerokość kubełka danych – zdarzenie należy do podpowiedzi punktu, gdy jest bliżej niż pół kubełka */
  bucketMs?: number;
}

const EVENT_COLOR: Record<EventKind, (e: ChartEvent) => string> = {
  alert: (e) => (e.severity === "critical" ? "--danger" : e.severity === "warning" ? "--warning" : "--accent"),
  alert_end: () => "--success",
  restart: () => "--chart-6",
  wan_switch: () => "--accent",
};
const EVENT_ICON: Record<EventKind, string> = { alert: "⚠", alert_end: "✓", restart: "↻", wan_switch: "⇄" };
const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const timeFmt = new Intl.DateTimeFormat("pl", { dateStyle: "short", timeStyle: "medium" });

export default function PanelChart({ lines, kind, stack, smooth, left, right, thresholds, thresholdStyle, height, ariaLabel, instanceRef, events = [], bucketMs = 30_000 }: PanelChartProps) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const { resolved } = useTheme();
  const { zoom } = useRefresh();

  useEffect(() => {
    if (!el.current) return;
    const instance = echarts.init(el.current, undefined, { renderer: "canvas" });
    chart.current = instance;
    if (instanceRef) instanceRef.current = instance;
    const observer = new ResizeObserver(() => instance.resize());
    observer.observe(el.current);
    const unlink = linkChart(instance);
    return () => {
      unlink();
      observer.disconnect();
      instance.dispose();
      chart.current = null;
      if (instanceRef) instanceRef.current = null;
    };
  }, [instanceRef]);

  useEffect(() => {
    const instance = chart.current;
    if (!instance) return;
    const text = css("--text-2");
    const grid = css("--border");
    const surface = css("--surface");
    const showLines = thresholdStyle === "line" || thresholdStyle === "line_area";
    const showArea = thresholdStyle === "area" || thresholdStyle === "line_area";
    const activeThresholds = thresholdStyle === "off" ? [] : thresholds;
    const topThreshold = activeThresholds.length ? Math.max(...activeThresholds.map((th) => th.value)) : null;
    const dataTop = leftTop(lines, stack);
    const bandTop = Math.max(left.max ?? 0, dataTop, topThreshold ?? 0) * 1.1 || 1;
    const firstLeft = lines.findIndex((l) => l.axis === "left");
    // Oś Y skalowana do widocznego fragmentu, nie do całego zakresu
    const inZoom = (rows: ChartRow[]) => (zoom ? rows.filter(([time]) => time >= zoom.from && time <= zoom.to) : rows);

    const axis = (a: AxisView, position: "left" | "right", withThreshold: boolean) => ({
      type: "value",
      position,
      name: a.label ?? undefined,
      nameTextStyle: { color: text },
      min: a.min ?? (position === "left" ? 0 : undefined),
      // Próg ponad danymi też ma być widoczny
      max: a.max ?? (withThreshold && topThreshold != null ? (v: { max: number }) => Math.max(v.max, topThreshold * 1.05) : undefined),
      axisLabel: { color: text, formatter: (v: number) => a.format(v) },
      splitLine: { show: position === "left", lineStyle: { color: grid } },
    });

    instance.setOption(
      {
        animationDuration: 250,
        textStyle: { color: text },
        grid: { left: 8, right: right ? 8 : 16, top: left.label || right?.label ? 28 : 12, bottom: 8, containLabel: true },
        tooltip: {
          trigger: "axis",
          backgroundColor: surface,
          borderColor: grid,
          textStyle: { color: css("--text") },
          formatter: (params: { axisValue: number; marker: string; seriesName: string; seriesIndex: number; value: [number, number | null] }[]) => {
            const head = timeFmt.format(new Date(params[0].axisValue));
            const rows = params
              .map((p) => {
                const fmt = lines[p.seriesIndex]?.axis === "right" && right ? right.format : left.format;
                return `${p.marker} ${p.seriesName}: <b>${p.value[1] == null ? "–" : fmt(p.value[1])}</b>`;
              })
              .join("<br/>");
            // Zdarzenia przy kursorze (pół kubełka w każdą stronę) – tekst z API, więc bez HTML
            const near = events.filter((e) => Math.abs(new Date(e.time).getTime() - params[0].axisValue) <= bucketMs / 2);
            const notes = near
              .map((e) => `<div style="color:${css(EVENT_COLOR[e.kind](e))}">${EVENT_ICON[e.kind]} ${t(`event.${e.kind}`)}: ${escapeHtml(e.title)}</div>`)
              .join("");
            return `<div style="font-size:12px;color:${text}">${head}</div>${rows}${notes ? `<div style="margin-top:4px;font-size:12px">${notes}</div>` : ""}`;
          },
        },
        xAxis: {
          type: "time",
          // Powiększony fragment (zaznaczenie myszą) – ta sama oś na wszystkich wykresach
          min: zoom?.from,
          max: zoom?.to,
          axisLine: { lineStyle: { color: grid } },
          axisLabel: { color: text, hideOverlap: true },
          splitNumber: 4,
          splitLine: { show: false },
        },
        yAxis: right ? [axis(left, "left", true), axis(right, "right", false)] : [axis(left, "left", true)],
        series: [
          ...lines.map((l, i) => {
            const color = css(`--chart-${l.color}`);
            const yAxisIndex = l.axis === "right" && right ? 1 : 0;
            const marks =
              i === firstLeft && activeThresholds.length
                ? {
                    markLine: showLines
                      ? {
                          silent: true,
                          symbol: "none",
                          label: { show: true, position: "insideEndTop", color: text, formatter: (p: { value: number }) => left.format(p.value) },
                          data: activeThresholds.map((th) => ({ yAxis: th.value, lineStyle: { color: css(`--chart-${th.color}`), type: "dashed", width: 1.5 } })),
                        }
                      : undefined,
                    markArea: showArea
                      ? {
                          silent: true,
                          data: thresholdBands(activeThresholds, bandTop).map((b) => [
                            { yAxis: b.from, itemStyle: { color: css(`--chart-${b.color}`), opacity: 0.08 } },
                            { yAxis: b.to },
                          ]),
                        }
                      : undefined,
                  }
                : {};
            const stackId = stack ? l.axis : undefined;
            if (kind === "bar") {
              return { name: l.name, type: "bar", yAxisIndex, stack: stackId, barMaxWidth: 14, itemStyle: { color }, data: inZoom(l.rows), ...marks };
            }
            return {
              name: l.name,
              type: "line",
              yAxisIndex,
              stack: stackId,
              smooth,
              showSymbol: false,
              symbol: "circle",
              symbolSize: 6,
              lineStyle: { width: 2, color, type: l.dashed ? "dashed" : "solid" },
              itemStyle: { color },
              areaStyle: kind === "area" ? { color, opacity: stack ? 0.35 : 0.1 } : undefined,
              data: inZoom(l.rows),
              ...marks,
            };
          }),
          // Zdarzenia: pusta seria tylko z pionowymi kreskami (progi zajmują już markLine pierwszej serii)
          ...(events.length
            ? [
                {
                  name: "",
                  type: "line",
                  data: [],
                  markLine: {
                    silent: true,
                    symbol: ["none", "circle"],
                    symbolSize: 6,
                    label: { show: false },
                    data: events.map((e) => ({ xAxis: new Date(e.time).getTime(), lineStyle: { color: css(EVENT_COLOR[e.kind](e)), type: "dashed", width: 1, opacity: 0.8 } })),
                  },
                },
              ]
            : []),
        ],
      },
      true,
    );
  }, [lines, kind, stack, smooth, left, right, thresholds, thresholdStyle, resolved, zoom, events, bucketMs]);

  return (
    <ZoomLayer chart={chart} height={height}>
      <div ref={el} role="img" aria-label={ariaLabel} className="h-full w-full" />
    </ZoomLayer>
  );
}
