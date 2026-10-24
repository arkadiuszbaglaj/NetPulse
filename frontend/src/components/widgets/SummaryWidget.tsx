import { t } from "../../i18n";
import { formatBps } from "../../lib/format";
import type { SummaryTile } from "../../lib/layout";
import { useDashboardSummary } from "../../lib/queries";
import { Card, ErrorNote } from "../ui";

function Metric({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: string | number;
  note?: string;
  tone?: "success" | "danger";
}) {
  const color = tone === "success" ? "text-success" : tone === "danger" ? "text-danger" : "text-text";
  return (
    <Card className="px-4 py-3">
      <p className="text-xs text-text-2">{label}</p>
      <p className={`mt-0.5 text-2xl font-medium ${color}`}>{value}</p>
      {note && <p className="mt-0.5 text-xs text-text-2">{note}</p>}
    </Card>
  );
}

/** Kafelki z kluczowymi liczbami; które pokazać, wybiera użytkownik. */
export function SummaryWidget({ tiles }: { tiles: SummaryTile[] }) {
  const { data: s, isError } = useDashboardSummary();
  if (!s) return isError ? <ErrorNote>{t("dash.error")}</ErrorNote> : null;
  const shown: Record<SummaryTile, React.ReactNode> = {
    devices: (
      <Metric
        label={t("dash.devices")}
        value={`${s.devices.up} ${t("dash.of", { total: s.devices.total })}`}
        tone={s.devices.down > 0 ? "danger" : s.devices.up > 0 ? "success" : undefined}
        note={s.devices.down > 0 ? `${s.devices.down} ${t("dash.down").toLowerCase()}` : t("dash.up")}
      />
    ),
    wan_down: <Metric label={t("dash.wanDown")} value={formatBps(s.wan.in_bps)} />,
    wan_up: <Metric label={t("dash.wanUp")} value={formatBps(s.wan.out_bps)} />,
    wifi_clients: <Metric label={t("dash.wifiClients")} value={s.wifi_clients ?? "–"} />,
  };
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-3">
      {tiles.map((tile) => (
        <div key={tile}>{shown[tile]}</div>
      ))}
    </div>
  );
}
