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
/** Numer koloru z palety motywu (--chart-1…8 w index.css; ta sama lista w layout_schemas.py). */
export type ColorIndex = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export const COLOR_INDEXES: ColorIndex[] = [1, 2, 3, 4, 5, 6, 7, 8];
/** Kolor kolejnej serii bez wybranego koloru. */
export const autoColor = (i: number): ColorIndex => ((i % COLOR_INDEXES.length) + 1) as ColorIndex;
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
export type AgentSourceKind = "agent_cpu" | "agent_net" | "agent_disk" | "agent_temp" | "agent_container" | "pve_guest";
export const AGENT_SOURCE_KINDS: AgentSourceKind[] = ["agent_cpu", "agent_net", "agent_disk", "agent_temp", "agent_container", "pve_guest"];
export const isAgentSource = (kind: SourceKind): kind is AgentSourceKind => (AGENT_SOURCE_KINDS as string[]).includes(kind);
export const SOURCE_KINDS: SourceKind[] = ["wan", "interface", "device", "wifi_total", "wifi_network", "server", ...AGENT_SOURCE_KINDS];

export type Axis = "left" | "right";
/** Porównanie w czasie: to samo okno godzinę, dzień albo tydzień wcześniej (parametr `offset` API metryk). */
export type OffsetMinutes = 0 | 60 | 1440 | 10080;
export const OFFSET_OPTIONS: OffsetMinutes[] = [0, 60, 1440, 10080];
export type LegendValue = "last" | "min" | "max" | "avg";
export const LEGEND_VALUES: LegendValue[] = ["last", "min", "max", "avg"];
export type LegendMode = "list" | "table" | "hidden";
export type ThresholdStyle = "off" | "line" | "area" | "line_area";
export const MAX_QUERIES = 6;
export const MAX_SERIES = 12;
const QUERY_IDS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export interface SeriesConfig {
  key: string;
  color?: ColorIndex | null;
  label?: string | null;
  axis?: Axis;
}

/** Jedno źródło danych wykresu (schemat: backend/netpulse/api/layout_schemas.py ChartQuery). */
export interface ChartQuery {
  id: string;
  source: Source;
  series: SeriesConfig[];
  offset_min?: OffsetMinutes;
}

/** Zakres osi w jednostkach surowych metryki (przepustowość w bit/s); puste = automatycznie. */
export interface AxisConfig {
  min?: number | null;
  max?: number | null;
  label?: string | null;
}

/** Próg w jednostkach surowych osi lewej. */
export interface Threshold {
  value: number;
  color: ColorIndex;
}

export interface LegendConfig {
  mode: LegendMode;
  placement: "bottom" | "right";
  values: LegendValue[];
}

export interface ChartConfig {
  title?: string | null;
  queries: ChartQuery[];
  chart: ChartKind;
  stack?: boolean;
  unit: ChartUnit;
  smooth: boolean;
  axes?: { left?: AxisConfig; right?: AxisConfig };
  thresholds?: Threshold[];
  threshold_style?: ThresholdStyle;
  legend?: LegendConfig;
  range_min?: RangeMinutes | null;
  refresh_s?: RefreshSeconds | null;
  height: ChartHeight;
}

/** Konfiguracja wykresu sprzed 0.26.0: jedno źródło i `y_max`. Serwer zamienia ją przy odczycie; tu na wszelki wypadek. */
export type LegacyChartConfig = Omit<ChartConfig, "queries"> & { source: Source; series: SeriesConfig[]; y_max?: number | null };

export function upgradeChartConfig(c: ChartConfig | LegacyChartConfig): ChartConfig {
  if (!("source" in c) || "queries" in c) return c as ChartConfig;
  const { source, series, y_max, ...rest } = c;
  return { ...rest, queries: [{ id: "A", source, series, offset_min: 0 }], axes: y_max != null ? { left: { max: y_max } } : rest.axes };
}

export const DEFAULT_LEGEND: LegendConfig = { mode: "list", placement: "bottom", values: [] };

/** Wszystkie serie wykresu w kolejności zapytań, z zapytaniem, do którego należą. */
export function allSeries(c: ChartConfig): { query: ChartQuery; series: SeriesConfig }[] {
  return c.queries.flatMap((query) => query.series.map((series) => ({ query, series })));
}

/** Jednostka osi = jednostka pierwszej serii na tej osi; null, gdy oś jest pusta. */
export function axisClass(c: ChartConfig, axis: Axis): UnitClass | null {
  const first = allSeries(c).find(({ series }) => (series.axis ?? "left") === axis);
  return first ? unitClassOf(first.series.key) : null;
}

/** Kolejny wolny identyfikator zapytania: A, B, C… */
export function nextQueryId(c: ChartConfig): string {
  const used = new Set(c.queries.map((q) => q.id));
  return [...QUERY_IDS].find((id) => !used.has(id)) ?? "Z";
}

/** Pierwszy kolor palety, którego nie używa jeszcze żadna seria wykresu. */
export function freeColor(c: ChartConfig): ColorIndex {
  const used = new Set(allSeries(c).map(({ series }) => series.color));
  return COLOR_INDEXES.find((i) => !used.has(i)) ?? 1;
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
/** Łącza WAN (dual WAN): `device_id` – router, puste = wszystkie routery. */
export type WanMetric = "in_bps" | "out_bps";
export type WanStatusWidgetModel = WidgetBase & { type: "wan_status"; config: { device_id?: number | null } };
export type WanChartWidgetModel = WidgetBase & {
  type: "wan_chart";
  config: { device_id?: number | null; metric: WanMetric; range_min?: RangeMinutes | null; height: ChartHeight };
};
export type WanSlaWidgetModel = WidgetBase & { type: "wan_sla"; config: { device_id?: number | null; days: 1 | 7 | 30 } };
export type Widget =
  | SummaryWidgetModel
  | ChartWidgetModel
  | DevicesWidgetModel
  | PoeWidgetModel
  | ServerWidgetModel
  | WanStatusWidgetModel
  | WanChartWidgetModel
  | WanSlaWidgetModel;
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
  guest_cpu_percent: { label: "metric.guest_cpu_percent", unitClass: "percent" },
  guest_mem_bytes: { label: "metric.guest_mem_bytes", unitClass: "size" },
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
  pve_guest: ["guest_cpu_percent", "guest_mem_bytes", "rx_bps", "tx_bps", "read_bps", "write_bps"],
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
    case "pve_guest":
      return [{ key: "guest_cpu_percent", color: 1 }];
  }
}

/** Włącza albo wyłącza metrykę w zapytaniu. Nowa seria o innej jednostce niż oś lewa trafia na oś prawą. */
export function toggleMetric(c: ChartConfig, queryId: string, key: string, enabled: boolean): ChartConfig {
  const queries = c.queries.map((q) => {
    if (q.id !== queryId) return q;
    if (!enabled) return { ...q, series: q.series.filter((s) => s.key !== key) };
    if (q.series.some((s) => s.key === key)) return q;
    const left = axisClass(c, "left");
    const axis: Axis = left && left !== unitClassOf(key) ? "right" : "left";
    return { ...q, series: [...q.series, { key, color: freeColor(c), axis }] };
  });
  return { ...c, queries };
}

// --- fabryki widgetów ------------------------------------------------------------------

export function newId(): string {
  return `w${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-3)}`;
}

export function newQuery(id: string, source: Source, series: SeriesConfig[] = defaultSeries(source.kind)): ChartQuery {
  return { id, source, series, offset_min: 0 };
}

/** Wykres z jednym źródłem; `series` domyślnie jak dla źródła. */
export function newChartConfig(source: Source = { kind: "wan" }, series?: SeriesConfig[]): ChartConfig {
  return {
    title: null,
    queries: [newQuery("A", source, series)],
    chart: "area",
    stack: false,
    unit: "bits",
    smooth: false,
    axes: { left: { min: null, max: null, label: null }, right: { min: null, max: null, label: null } },
    thresholds: [],
    threshold_style: "line",
    legend: { ...DEFAULT_LEGEND },
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
    case "wan_status":
      return { id, type, w: 4, config: { device_id: null } };
    case "wan_chart":
      return { id, type, w: 8, config: { device_id: null, metric: "in_bps", range_min: null, height: "md" } };
    case "wan_sla":
      return { id, type, w: 12, config: { device_id: null, days: 7 } };
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
      config: newChartConfig({ kind: "wan" }),
    },
    {
      id: "klienci-wifi",
      type: "chart",
      w: 4,
      config: newChartConfig({ kind: "wifi_total" }),
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

// --- przeliczanie osi i progów: wartość w jednostce widocznej dla użytkownika ↔ surowa z API ---

/** Surowa metryka przepustowości jest w bitach/s: wyświetlamy Mb/s albo MB/s. Rozmiar (bajty) – w GB. */
const MB = 1_000_000;
const GB = 1_000_000_000;

export function valueToRaw(display: number, cls: UnitClass | null, unit: ChartUnit): number {
  if (cls === "rate") return unit === "bytes" ? display * MB * 8 : display * MB;
  if (cls === "size") return display * GB;
  return display;
}

export function valueFromRaw(raw: number, cls: UnitClass | null, unit: ChartUnit): number {
  if (cls === "rate") return unit === "bytes" ? raw / (MB * 8) : raw / MB;
  if (cls === "size") return raw / GB;
  return raw;
}
