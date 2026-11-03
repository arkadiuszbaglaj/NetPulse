import type { SeriesPoint } from "../../lib/api";
import { t } from "../../i18n";
import { formatBps } from "../../lib/format";
import type { SummaryTile } from "../../lib/layout";
import { useDashboardSummary, useSeries } from "../../lib/queries";
import { Card, ErrorNote } from "../ui";

/** Mini-wykres (linia) z wartości w zakresie pulpitu; mniej niż 2 punkty – nic. */
export function Sparkline({ values }: { values: (number | null)[] }) {
  const known = values.map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] != null);
  if (known.length < 2) return null;
  const max = Math.max(...known.map((p) => p[1]));
  const min = Math.min(...known.map((p) => p[1]));
  const span = max - min || 1;
  const last = values.length - 1 || 1;
  const points = known.map(([i, v]) => `${((i / last) * 120).toFixed(1)},${(28 - ((v - min) / span) * 24).toFixed(1)}`).join(" ");
  return (
    <svg width="80" height="28" viewBox="0 0 120 32" fill="none" aria-hidden="true" className="min-w-0 shrink text-text-2">
      <polyline points={points} stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** Najwyższa wartość serii i jej godzina („szczyt 846 Mb/s o 20:14”). */
export function peakOf(points: SeriesPoint[], key: string): { value: number; time: string } | null {
  let best: { value: number; time: string } | null = null;
  for (const p of points) {
    const v = p.values[key];
    if (v != null && (!best || v > best.value)) best = { value: v, time: p.time };
  }
  return best;
}

const hour = (iso: string) => new Date(iso).toLocaleTimeString("pl-PL", { hour: "2-digit", minute: "2-digit" });

function Metric({
  label,
  value,
  note,
  tone,
  spark,
}: {
  label: string;
  value: string | number;
  note?: string;
  tone?: "success" | "danger";
  spark?: (number | null)[];
}) {
  const color = tone === "success" ? "text-success" : tone === "danger" ? "text-danger" : "text-text";
  return (
    <Card className="flex h-full flex-col px-5 py-4">
      <p className="text-[13px] font-medium text-muted">{label}</p>
      <div className="mt-2 flex items-end justify-between gap-3">
        <p className={`whitespace-nowrap text-[28px] font-semibold leading-none tracking-tight ${color}`}>{value}</p>
        {spark && <Sparkline values={spark} />}
      </div>
      {note && <p className="mt-2 text-xs text-muted">{note}</p>}
    </Card>
  );
}

/** Kafelki z kluczowymi liczbami; które pokazać, wybiera użytkownik. Od 0.42.0 z mini-wykresem i szczytem w zakresie pulpitu. */
export function SummaryWidget({ tiles }: { tiles: SummaryTile[] }) {
  const { data: s, isError } = useDashboardSummary();
  const wanTiles = tiles.includes("wan_down") || tiles.includes("wan_up");
  const traffic = useSeries("traffic", wanTiles).data?.points ?? [];
  const wifi = useSeries("wifi", tiles.includes("wifi_clients")).data?.points ?? [];
  if (!s) return isError ? <ErrorNote>{t("dash.error")}</ErrorNote> : null;
  const peakNote = (key: string) => {
    const p = peakOf(traffic, key);
    return p ? t("dash.peak", { value: formatBps(p.value), time: hour(p.time) }) : undefined;
  };
  const wifiPeak = peakOf(wifi, "clients");
  const shown: Record<SummaryTile, React.ReactNode> = {
    devices: (
      <Metric
        label={t("dash.devices")}
        value={`${s.devices.up} ${t("dash.of", { total: s.devices.total })}`}
        tone={s.devices.down > 0 ? "danger" : s.devices.up > 0 ? "success" : undefined}
        note={s.devices.down > 0 ? `${s.devices.down} ${t("dash.down").toLowerCase()}` : t("dash.up")}
      />
    ),
    wan_down: (
      <Metric label={t("dash.wanDown")} value={formatBps(s.wan.in_bps)} note={peakNote("in_bps")} spark={traffic.map((p) => p.values.in_bps)} />
    ),
    wan_up: (
      <Metric label={t("dash.wanUp")} value={formatBps(s.wan.out_bps)} note={peakNote("out_bps")} spark={traffic.map((p) => p.values.out_bps)} />
    ),
    wifi_clients: (
      <Metric
        label={t("dash.wifiClients")}
        value={s.wifi_clients ?? "–"}
        note={wifiPeak ? t("dash.wifiPeak", { n: Math.round(wifiPeak.value) }) : undefined}
        spark={wifi.map((p) => p.values.clients)}
      />
    ),
  };
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-4">
      {tiles.map((tile) => (
        <div key={tile}>{shown[tile]}</div>
      ))}
    </div>
  );
}
