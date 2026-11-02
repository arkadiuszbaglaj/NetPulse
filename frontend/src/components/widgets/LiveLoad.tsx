import { t } from "../../i18n";
import { formatSpeed } from "../../lib/details";
import { formatBps } from "../../lib/format";
import { loadPercent, type LiveWanPort } from "../../lib/live";

const pctFormat = new Intl.NumberFormat("pl", { maximumFractionDigits: 1 });

/** Pasek obciążenia portu (większy z kierunków względem prędkości łącza). */
export function LoadBar({ in_bps, out_bps, speedMbps }: { in_bps: number | null; out_bps: number | null; speedMbps: number | null | undefined }) {
  const pct = loadPercent({ in_bps, out_bps }, speedMbps);
  if (pct == null) return null;
  const tone = pct >= 80 ? "bg-danger" : pct >= 50 ? "bg-warning" : "bg-accent";
  const label = t("live.load", { pct: pctFormat.format(pct), speed: formatSpeed(speedMbps ?? null) });
  return (
    <div className="flex items-center gap-2" title={label}>
      <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} className="h-1.5 min-w-12 flex-1 overflow-hidden rounded-full bg-surface-2">
        <div className={`h-full rounded-full ${tone} transition-[width] duration-500`} style={{ width: `${Math.max(pct, pct > 0 ? 2 : 0)}%` }} />
      </div>
      <span className="w-12 shrink-0 text-right text-xs tabular-nums text-text-2">{pctFormat.format(pct)}%</span>
    </div>
  );
}

/** Każdy port WAN osobno w trybie „Na żywo”: pobieranie, wysyłanie i obciążenie łącza. */
export function WanPortsLive({ ports }: { ports: LiveWanPort[] }) {
  if (ports.length === 0) return null;
  return (
    <ul className="mb-2 flex flex-col gap-1.5 text-sm" aria-label={t("live.wanPorts")}>
      {ports.map((p) => (
        <li key={p.id} className="grid grid-cols-[minmax(0,8rem)_auto_auto_minmax(6rem,1fr)] items-center gap-x-3 max-sm:grid-cols-2">
          <span className="truncate font-medium" title={p.name}>
            {p.name}
          </span>
          <span className="tabular-nums text-text-2">↓ {formatBps(p.in_bps)}</span>
          <span className="tabular-nums text-text-2">↑ {formatBps(p.out_bps)}</span>
          <LoadBar in_bps={p.in_bps} out_bps={p.out_bps} speedMbps={p.speed_mbps} />
        </li>
      ))}
    </ul>
  );
}
