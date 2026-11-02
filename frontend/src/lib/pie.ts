/** Wykres kołowy (0.39.0): co można monitorować na urządzeniu i jak z wierszy kolekcji powstają kawałki koła.
 * Ta sama lista metryk i kolekcji co `PIE_COLLECTION` w backend/netpulse/api/layout_schemas.py. */
import { t, type TextKey } from "../i18n";
import type { Device } from "./api";
import { formatSpeed } from "./details";
import { formatBps, metricFormatter } from "./format";
import { unitClassOf, type Collection, type CollectionKind, type PieConfig, type PieMetric } from "./layout";
import type { CollectionRow } from "./panels";

/** Zajętość (zajęte / wolne), udział (kawałek na wiersz) albo stan (działa / nie działa). */
export type PieMode = "usage" | "share" | "state";

interface PieDef {
  label: TextKey;
  mode: PieMode;
  kind: CollectionKind;
  key: string;
  /** device = wymagane urządzenie, optional = puste to wszystkie, global = cała sieć */
  scope: "device" | "optional" | "global";
}

export const PIE_METRICS: Record<PieMetric, PieDef> = {
  cpu: { label: "pie.m.cpu", mode: "usage", kind: "devices", key: "cpu_percent", scope: "device" },
  mem: { label: "pie.m.mem", mode: "usage", kind: "devices", key: "mem_used_percent", scope: "device" },
  disk: { label: "pie.m.disk", mode: "usage", kind: "disks", key: "used_bytes", scope: "device" },
  disks_share: { label: "pie.m.disks_share", mode: "share", kind: "disks", key: "used_bytes", scope: "device" },
  port_load: { label: "pie.m.port_load", mode: "usage", kind: "ports", key: "in_bps", scope: "device" },
  port_dir: { label: "pie.m.port_dir", mode: "share", kind: "ports", key: "in_bps", scope: "device" },
  // Wszystkie porty na jednym wykresie – tylko zapisane pulpity sprzed 0.40.0 (edytor ich nie proponuje)
  ports_in: { label: "pie.m.ports_in", mode: "share", kind: "ports", key: "in_bps", scope: "device" },
  ports_out: { label: "pie.m.ports_out", mode: "share", kind: "ports", key: "out_bps", scope: "device" },
  ports_state: { label: "pie.m.ports_state", mode: "state", kind: "ports", key: "up", scope: "device" },
  wifi_clients: { label: "pie.m.wifi_clients", mode: "share", kind: "wifi", key: "clients", scope: "optional" },
  containers_mem: { label: "pie.m.containers_mem", mode: "share", kind: "containers", key: "mem_bytes", scope: "device" },
  containers_cpu: { label: "pie.m.containers_cpu", mode: "share", kind: "containers", key: "cpu_percent", scope: "device" },
  services_state: { label: "pie.m.services_state", mode: "state", kind: "services", key: "up", scope: "device" },
  guests_mem: { label: "pie.m.guests_mem", mode: "share", kind: "guests", key: "mem_bytes", scope: "optional" },
  guests_state: { label: "pie.m.guests_state", mode: "state", kind: "guests", key: "up", scope: "optional" },
  devices_state: { label: "pie.m.devices_state", mode: "state", kind: "devices", key: "up", scope: "global" },
  checks_state: { label: "pie.m.checks_state", mode: "state", kind: "checks", key: "up", scope: "global" },
};

/** Co można monitorować na urządzeniu; `null` = cała sieć (bez wybranego urządzenia). */
export function pieMetricsFor(device: Pick<Device, "driver" | "kind"> | null): PieMetric[] {
  if (!device) return ["devices_state", "checks_state", "wifi_clients"];
  if (device.driver === "agent") return ["cpu", "mem", "disk", "disks_share", "containers_mem", "containers_cpu", "services_state"];
  if (device.driver === "proxmox") return ["cpu", "mem", "guests_mem", "guests_state"];
  return [
    "cpu",
    "mem",
    "port_load",
    "port_dir",
    "ports_state",
    ...(device.kind === "ap" ? (["wifi_clients"] as const) : []),
    ...(device.kind === "server" ? (["disk", "disks_share"] as const) : []),
  ];
}

/** Wykres jednego portu (wybór portu w edytorze) */
export const isPortMetric = (m: PieMetric) => m === "port_load" || m === "port_dir";
/** Wykres z ruchu portów – te pokazują dane na żywo */
export const isLiveMetric = (m: PieMetric) => isPortMetric(m) || m === "ports_in" || m === "ports_out";

/** Kolekcja z danymi wykresu (CPU i RAM – wiersz urządzenia w kolekcji wszystkich urządzeń). */
export function pieCollection(config: PieConfig): Collection {
  const def = PIE_METRICS[config.metric];
  return { kind: def.kind, device_id: def.kind === "devices" || def.kind === "checks" ? null : (config.device_id ?? null) };
}

export interface PieSlice {
  key: string;
  label: string;
  value: number;
  color: string;
  /** Wartość do legendy (np. „12 Mb/s”, „3,2 GB”) */
  text: string;
}
export interface PieData {
  slices: PieSlice[];
  /** Duża liczba w środku koła i podpis pod nią */
  center: string;
  sub: string;
}

const chartColor = (n: number) => `var(--chart-${n})`;
const FREE = "var(--surface-2)";
const pct = (v: number) => `${new Intl.NumberFormat("pl", { maximumFractionDigits: 0 }).format(v)}%`;

function usageColor(percent: number): string {
  return chartColor(percent >= 90 ? 5 : percent >= 70 ? 4 : 1);
}

/** Kawałki koła z wierszy kolekcji; null, gdy nie ma czego pokazać (np. urządzenie bez odczytu CPU). */
export function pieData(config: PieConfig, rows: CollectionRow[]): PieData | null {
  const def = PIE_METRICS[config.metric];
  if (isPortMetric(config.metric)) return portData(config.metric, rows.find((r) => r.key === config.item));
  if (def.mode === "usage") {
    if (def.kind === "disks") {
      const row = rows.find((r) => r.key === config.item) ?? rows[0];
      const used = row?.values.used_bytes;
      const free = row?.values.free_bytes;
      if (row == null || used == null || free == null) return null;
      const size = metricFormatter("size", "bits");
      const percent = row.values.used_percent ?? (used + free > 0 ? (used / (used + free)) * 100 : 0);
      return {
        slices: [
          { key: "used", label: t("pie.used"), value: used, color: usageColor(percent), text: size(used) },
          { key: "free", label: t("pie.free"), value: free, color: FREE, text: size(free) },
        ],
        center: pct(percent),
        sub: row.label,
      };
    }
    const row = rows.find((r) => r.key === String(config.device_id));
    const v = row?.values[def.key];
    if (row == null || v == null) return null;
    const used = Math.min(100, Math.max(0, v));
    return {
      slices: [
        { key: "used", label: t("pie.used"), value: used, color: usageColor(used), text: pct(used) },
        { key: "free", label: t("pie.free"), value: 100 - used, color: FREE, text: pct(100 - used) },
      ],
      center: pct(used),
      sub: t(def.label),
    };
  }

  if (def.mode === "state") {
    const up = rows.filter((r) => r.values.up === 1).length;
    const down = rows.filter((r) => r.values.up === 0).length;
    const unknown = rows.length - up - down;
    if (rows.length === 0) return null;
    const count = (n: number) => String(n);
    const slices: PieSlice[] = [
      { key: "up", label: t("pie.state.up"), value: up, color: chartColor(2), text: count(up) },
      { key: "down", label: t("pie.state.down"), value: down, color: chartColor(5), text: count(down) },
      { key: "unknown", label: t("pie.state.unknown"), value: unknown, color: chartColor(8), text: count(unknown) },
    ];
    return { slices: slices.filter((s) => s.value > 0), center: t("pie.state.center", { up, total: rows.length }), sub: t("pie.state.sub") };
  }

  const format = metricFormatter(unitClassOf(def.key), "bits");
  const values = rows
    .map((r) => ({ row: r, v: r.values[def.key] }))
    .filter((x): x is { row: CollectionRow; v: number } => x.v != null && x.v > 0)
    .sort((a, b) => b.v - a.v);
  if (values.length === 0) return null;
  const shown = values.length > config.limit ? values.slice(0, config.limit - 1) : values;
  const rest = values.slice(shown.length).reduce((sum, x) => sum + x.v, 0);
  const slices: PieSlice[] = shown.map((x, i) => ({ key: x.row.key, label: x.row.label, value: x.v, color: chartColor((i % 7) + 1), text: format(x.v) }));
  if (rest > 0) slices.push({ key: "__rest", label: t("pie.rest"), value: rest, color: chartColor(8), text: format(rest) });
  const total = values.reduce((sum, x) => sum + x.v, 0);
  return { slices, center: format(total), sub: t("pie.total") };
}

/** Jeden port: obciążenie (większy z kierunków względem prędkości portu) albo odbierane / wysyłane. */
function portData(metric: PieMetric, row: CollectionRow | undefined): PieData | null {
  const rx = row?.values.in_bps;
  const tx = row?.values.out_bps;
  if (row == null || rx == null || tx == null) return null;
  if (metric === "port_dir") {
    return {
      slices: [
        { key: "in", label: t("port.in"), value: rx, color: chartColor(1), text: formatBps(rx) },
        { key: "out", label: t("port.out"), value: tx, color: chartColor(2), text: formatBps(tx) },
      ],
      center: formatBps(rx + tx),
      sub: t("pie.total"),
    };
  }
  const speed = row.values.speed_mbps;
  if (!speed) return null; // port odłączony albo bez prędkości
  const cap = speed * 1_000_000;
  const used = Math.min(cap, Math.max(rx, tx));
  const percent = (used / cap) * 100;
  return {
    slices: [
      { key: "used", label: t("pie.used"), value: used, color: usageColor(percent), text: formatBps(used) },
      { key: "free", label: t("pie.free"), value: cap - used, color: FREE, text: formatBps(cap - used) },
    ],
    center: pct(percent),
    sub: t("pie.port.of", { speed: formatSpeed(speed) }),
  };
}

/** Tytuł: co, wybrany port albo dysk i urządzenie, np. „Obciążenie portu · Port 8 · USW Lite 8 PoE”. */
export function pieTitle(config: PieConfig, deviceName?: string | null, itemLabel?: string | null): string {
  if (config.title) return config.title;
  return [t(PIE_METRICS[config.metric].label), itemLabel, deviceName].filter(Boolean).join(" · ");
}
