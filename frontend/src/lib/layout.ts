/**
 * Model układu pulpitu (wersja 1) – odpowiada schematowi w backend/netpulse/api/layout_schemas.py.
 * Czyste funkcje (bez Reacta): układ domyślny i operacje edytora, żeby łatwo je testować.
 */
import type { TextKey } from "../i18n";
import type { RangeMinutes, RefreshSeconds } from "./refresh";

export type GridWidth = 3 | 4 | 6 | 8 | 12;
export const GRID_WIDTHS: GridWidth[] = [3, 4, 6, 8, 12];
export const MAX_WIDGETS = 40;

export type ChartKind = "line" | "area" | "bar";
export type ChartUnit = "bits" | "bytes";
export type ChartHeight = "sm" | "md" | "lg";
export type ColorIndex = 1 | 2 | 3 | 4;
export type DeviceKind = "gateway" | "switch" | "ap" | "server" | "other";
export type SummaryTile = "devices" | "wan_down" | "wan_up" | "wifi_clients";
export const SUMMARY_TILES: SummaryTile[] = ["devices", "wan_down", "wan_up", "wifi_clients"];
export const DEVICE_KINDS: DeviceKind[] = ["gateway", "switch", "ap", "server", "other"];

export type Source =
  | { kind: "wan" }
  | { kind: "wifi_total" }
  | { kind: "interface"; id: number; device_id?: number | null }
  | { kind: "device"; id: number }
  | { kind: "wifi_network"; id: number; device_id?: number | null }
  | { kind: "server" }
  | { kind: AgentSourceKind; id: number; key: string };
export type SourceKind = Source["kind"];
/** Źródła z agenta serwera: urządzenie (`id`) i wybrany interfejs, dysk, czujnik albo kontener (`key`). */
export type AgentSourceKind = "agent_cpu" | "agent_net" | "agent_disk" | "agent_temp" | "agent_container";
export const AGENT_SOURCE_KINDS: AgentSourceKind[] = ["agent_cpu", "agent_net", "agent_disk", "agent_temp", "agent_container"];
export const isAgentSource = (kind: SourceKind): kind is AgentSourceKind => (AGENT_SOURCE_KINDS as string[]).includes(kind);
export const SOURCE_KINDS: SourceKind[] = ["wan", "interface", "device", "wifi_total", "wifi_network", "server", ...AGENT_SOURCE_KINDS];

export interface SeriesConfig {
  key: string;
  color?: ColorIndex | null;
  label?: string | null;
}

export interface ChartConfig {
  title?: string | null;
  source: Source;
  series: SeriesConfig[];
  chart: ChartKind;
  unit: ChartUnit;
  smooth: boolean;
  y_max?: number | null;
  range_min?: RangeMinutes | null;
  refresh_s?: RefreshSeconds | null;
  height: ChartHeight;
}

interface WidgetBase {
  id: string;
  w: GridWidth;
}
export type SummaryWidgetModel = WidgetBase & { type: "summary"; config: { tiles: SummaryTile[] } };
export type ChartWidgetModel = WidgetBase & { type: "chart"; config: ChartConfig };
export type DevicesWidgetModel = WidgetBase & { type: "devices"; config: { kinds?: DeviceKind[] | null } };
export type PoeWidgetModel = WidgetBase & { type: "poe"; config: { device_id?: number | null } };
export type ServerWidgetModel = WidgetBase & { type: "server"; config: Record<string, never> };
export type Widget = SummaryWidgetModel | ChartWidgetModel | DevicesWidgetModel | PoeWidgetModel | ServerWidgetModel;
export type WidgetType = Widget["type"];

export interface DashboardLayout {
  version: 1;
  widgets: Widget[];
}

export interface DashboardResponse {
  layout: DashboardLayout | null;
  updated_at: string | null;
}

// --- metryki ---------------------------------------------------------------------------

/** Klasa jednostki: metryki w jednym wykresie muszą należeć do tej samej klasy (wspólna oś Y). */
export type UnitClass = "rate" | "count" | "percent" | "load" | "ms" | "temp" | "size";

export const METRICS: Record<string, { label: TextKey; unitClass: UnitClass }> = {
  in_bps: { label: "metric.in_bps", unitClass: "rate" },
  out_bps: { label: "metric.out_bps", unitClass: "rate" },
  rx_bps: { label: "metric.rx_bps", unitClass: "rate" },
  tx_bps: { label: "metric.tx_bps", unitClass: "rate" },
  in_errors: { label: "metric.in_errors", unitClass: "count" },
  out_errors: { label: "metric.out_errors", unitClass: "count" },
  in_discards: { label: "metric.in_discards", unitClass: "count" },
  out_discards: { label: "metric.out_discards", unitClass: "count" },
  clients: { label: "metric.clients", unitClass: "count" },
  cpu_percent: { label: "metric.cpu_percent", unitClass: "percent" },
  mem_used_percent: { label: "metric.mem_used_percent", unitClass: "percent" },
  load1: { label: "metric.load1", unitClass: "load" },
  poll_ms: { label: "metric.poll_ms", unitClass: "ms" },
  swap_used_percent: { label: "metric.swap_used_percent", unitClass: "percent" },
  disk_used_percent: { label: "metric.disk_used_percent", unitClass: "percent" },
  temp_c: { label: "metric.temp_c", unitClass: "temp" },
  db_size_bytes: { label: "metric.db_size_bytes", unitClass: "size" },
  core_max_percent: { label: "metric.core_max_percent", unitClass: "percent" },
  core_avg_percent: { label: "metric.core_avg_percent", unitClass: "percent" },
  read_bps: { label: "metric.read_bps", unitClass: "rate" },
  write_bps: { label: "metric.write_bps", unitClass: "rate" },
  container_cpu_percent: { label: "metric.container_cpu_percent", unitClass: "percent" },
  container_mem_bytes: { label: "metric.container_mem_bytes", unitClass: "size" },
};

/** Metryki dostępne dla źródła (zgodnie z endpointami metryk i schematem serwera). */
export const SOURCE_METRICS: Record<SourceKind, string[]> = {
  wan: ["in_bps", "out_bps"],
  interface: ["in_bps", "out_bps", "in_errors", "out_errors", "in_discards", "out_discards"],
  device: ["cpu_percent", "mem_used_percent", "load1", "poll_ms"],
  wifi_total: ["clients"],
  wifi_network: ["clients", "rx_bps", "tx_bps"],
  server: ["cpu_percent", "mem_used_percent", "swap_used_percent", "disk_used_percent", "load1", "temp_c", "db_size_bytes"],
  agent_cpu: ["core_max_percent", "core_avg_percent"],
  agent_net: ["rx_bps", "tx_bps"],
  agent_disk: ["read_bps", "write_bps"],
  agent_temp: ["temp_c"],
  agent_container: ["container_cpu_percent", "container_mem_bytes"],
};

export const unitClassOf = (key: string): UnitClass => METRICS[key]?.unitClass ?? "count";

/** Domyślne serie dla źródła: dla przepustowości wejście i wyjście, dla reszty pierwsza metryka. */
export function defaultSeries(kind: SourceKind): SeriesConfig[] {
  switch (kind) {
    case "wan":
    case "interface":
      return [
        { key: "in_bps", color: 1 },
        { key: "out_bps", color: 2 },
      ];
    case "device":
      return [{ key: "cpu_percent", color: 1 }];
    case "wifi_total":
    case "wifi_network":
      return [{ key: "clients", color: 3 }];
    case "server":
      return [
        { key: "cpu_percent", color: 1 },
        { key: "mem_used_percent", color: 2 },
      ];
    case "agent_cpu":
      return [
        { key: "core_max_percent", color: 1 },
        { key: "core_avg_percent", color: 2 },
      ];
    case "agent_net":
      return [
        { key: "rx_bps", color: 1 },
        { key: "tx_bps", color: 2 },
      ];
    case "agent_disk":
      return [
        { key: "read_bps", color: 1 },
        { key: "write_bps", color: 2 },
      ];
    case "agent_temp":
      return [{ key: "temp_c", color: 3 }];
    case "agent_container":
      return [{ key: "container_cpu_percent", color: 1 }];
  }
}

/** Po zmianie metryk zostają tylko te z klasy jednostki ostatnio wybranej (jedna oś Y). */
export function toggleMetric(series: SeriesConfig[], key: string, enabled: boolean): SeriesConfig[] {
  if (!enabled) return series.filter((s) => s.key !== key);
  if (series.some((s) => s.key === key)) return series;
  const cls = unitClassOf(key);
  const kept = series.filter((s) => unitClassOf(s.key) === cls);
  const used = new Set(kept.map((s) => s.color));
  const color = ([1, 2, 3, 4] as ColorIndex[]).find((c) => !used.has(c)) ?? 1;
  return [...kept, { key, color }];
}

// --- fabryki widgetów ------------------------------------------------------------------

export function newId(): string {
  return `w${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-3)}`;
}

export function newChartConfig(source: Source = { kind: "wan" }): ChartConfig {
  return {
    title: null,
    source,
    series: defaultSeries(source.kind),
    chart: "area",
    unit: "bits",
    smooth: false,
    y_max: null,
    range_min: null,
    refresh_s: null,
    height: "md",
  };
}

export function newWidget(type: WidgetType, id: string = newId()): Widget {
  switch (type) {
    case "summary":
      return { id, type, w: 12, config: { tiles: [...SUMMARY_TILES] } };
    case "chart":
      return { id, type, w: 6, config: newChartConfig() };
    case "devices":
      return { id, type, w: 12, config: { kinds: null } };
    case "poe":
      return { id, type, w: 12, config: { device_id: null } };
    case "server":
      return { id, type, w: 4, config: {} };
  }
}

/** Układ domyślny: to samo, co pokazywał pulpit przed personalizacją. */
export const DEFAULT_LAYOUT: DashboardLayout = {
  version: 1,
  widgets: [
    { id: "podsumowanie", type: "summary", w: 12, config: { tiles: [...SUMMARY_TILES] } },
    {
      id: "ruch-wan",
      type: "chart",
      w: 8,
      config: { ...newChartConfig({ kind: "wan" }), series: defaultSeries("wan"), height: "md" },
    },
    {
      id: "klienci-wifi",
      type: "chart",
      w: 4,
      config: { ...newChartConfig({ kind: "wifi_total" }), series: defaultSeries("wifi_total"), height: "md" },
    },
    { id: "urzadzenia", type: "devices", w: 12, config: { kinds: null } },
  ],
};

// --- operacje edytora (zwracają nowy układ, niczego nie mutują) ------------------------

const indexOf = (l: DashboardLayout, id: string) => l.widgets.findIndex((w) => w.id === id);

/** Przenosi widget na pozycję `to` (0 = pierwszy). */
export function moveWidget(l: DashboardLayout, id: string, to: number): DashboardLayout {
  const from = indexOf(l, id);
  if (from < 0) return l;
  const clamped = Math.max(0, Math.min(l.widgets.length - 1, to));
  if (clamped === from) return l;
  const widgets = [...l.widgets];
  const [item] = widgets.splice(from, 1);
  widgets.splice(clamped, 0, item);
  return { ...l, widgets };
}

/** Przesuwa o jedno miejsce wcześniej (-1) albo później (+1). */
export function shiftWidget(l: DashboardLayout, id: string, delta: -1 | 1): DashboardLayout {
  const from = indexOf(l, id);
  return from < 0 ? l : moveWidget(l, id, from + delta);
}

/** Upuszczenie widgetu `id` na widget `targetId`: trafia na jego miejsce (przesuwając resztę). */
export function dropOn(l: DashboardLayout, id: string, targetId: string): DashboardLayout {
  const to = indexOf(l, targetId);
  return to < 0 || id === targetId ? l : moveWidget(l, id, to);
}

export function resizeWidget(l: DashboardLayout, id: string, w: GridWidth): DashboardLayout {
  return { ...l, widgets: l.widgets.map((x) => (x.id === id ? { ...x, w } : x)) };
}

export function removeWidget(l: DashboardLayout, id: string): DashboardLayout {
  return { ...l, widgets: l.widgets.filter((x) => x.id !== id) };
}

export function addWidget(l: DashboardLayout, widget: Widget): DashboardLayout {
  return l.widgets.length >= MAX_WIDGETS ? l : { ...l, widgets: [...l.widgets, widget] };
}

/** Podmienia widget o tym samym id (np. po edycji konfiguracji). */
export function replaceWidget(l: DashboardLayout, widget: Widget): DashboardLayout {
  return { ...l, widgets: l.widgets.map((x) => (x.id === widget.id ? widget : x)) };
}

export function sameLayout(a: DashboardLayout, b: DashboardLayout): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// --- przeliczanie osi Y: wartość w jednostce widocznej dla użytkownika ↔ surowa z API ---

/** Surowa metryka przepustowości jest w bitach/s: wyświetlamy Mb/s albo MB/s. */
const MB = 1_000_000;

export function yMaxToRaw(display: number, firstKey: string, unit: ChartUnit): number {
  if (unitClassOf(firstKey) !== "rate") return display;
  return unit === "bytes" ? display * MB * 8 : display * MB;
}

export function yMaxFromRaw(raw: number, firstKey: string, unit: ChartUnit): number {
  if (unitClassOf(firstKey) !== "rate") return raw;
  return unit === "bytes" ? raw / (MB * 8) : raw / MB;
}
