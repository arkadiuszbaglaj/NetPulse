import { IconBolt } from "@tabler/icons-react";
import { t } from "../../i18n";
import type { Device } from "../../lib/api";
import { useDevices } from "../../lib/queries";
import { formatWatts, usePoe } from "../../lib/unifi";
import { Card } from "../ui";

function SwitchPoe({ device }: { device: Device }) {
  const { data } = usePoe(device.id);
  if (!data || data.ports.length === 0) return null;
  const budget = data.budget;
  const pct = budget?.used_w != null && budget.max_w ? Math.min(100, (budget.used_w / budget.max_w) * 100) : null;
  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 truncate text-sm font-medium">
          <IconBolt size={18} aria-hidden="true" className="shrink-0 text-accent" />
          {t("poe.title", { name: device.name })}
        </h3>
        {budget && (
          <span className="shrink-0 text-xs text-text-2">
            {formatWatts(budget.used_w)} {t("poe.of", { max: formatWatts(budget.max_w) })}
          </span>
        )}
      </div>
      {pct != null && (
        <div role="meter" aria-label={t("poe.budget")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} className="mb-3 h-1.5 overflow-hidden rounded-full bg-surface-2">
          <div className={`h-full rounded-full ${pct > 85 ? "bg-danger" : "bg-accent"}`} style={{ width: `${pct}%` }} />
        </div>
      )}
      <ul className="divide-y divide-border text-sm">
        {data.ports.map((p) => (
          <li key={p.port_idx} className="flex items-center justify-between gap-3 py-1.5">
            <span className="min-w-0 truncate">
              <span className="text-text-2">{t("poe.port", { n: p.port_idx })}</span>
              {p.label && <span className="ml-2">{p.label}</span>}
            </span>
            <span className={p.delivering ? "font-medium" : "text-muted"}>
              {p.delivering ? formatWatts(p.power_w) : p.mode === "off" ? t("poe.off") : t("poe.idle")}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** PoE switchy: moc na portach i budżet. Dane z kontrolera UniFi; bez kontrolera widget jest pusty. */
export function PoeWidget({ deviceId }: { deviceId?: number | null }) {
  const { data } = useDevices();
  const devices = (data ?? []).filter((d) => d.kind === "switch" && (deviceId == null || d.id === deviceId));
  if (devices.length === 0) return null;
  return (
    <div className="grid gap-3 md:grid-cols-[repeat(auto-fill,minmax(280px,1fr))]">
      {devices.map((d) => (
        <SwitchPoe key={d.id} device={d} />
      ))}
    </div>
  );
}
