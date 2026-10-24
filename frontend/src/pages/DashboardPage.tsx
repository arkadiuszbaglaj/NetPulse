import { IconAccessPoint, IconDeviceDesktop, IconNetwork, IconRouter } from "@tabler/icons-react";
import { ChartCard } from "../components/charts/ChartCard";
import type { ChartSeries } from "../components/charts/TimeSeriesChart";
import { Card, ErrorNote, PageHeader } from "../components/ui";
import { t, type TextKey } from "../i18n";
import type { Device } from "../lib/api";
import { formatBps, formatRange, relativeTime } from "../lib/format";
import { useDashboardSummary, useDevices, useSeries } from "../lib/queries";
import { RANGE_OPTIONS, useRefresh } from "../lib/refresh";

const KIND_ICON = { gateway: IconRouter, switch: IconNetwork, ap: IconAccessPoint } as const;
const KIND_LABEL: Record<string, TextKey> = {
  gateway: "dash.kind.gateway",
  switch: "dash.kind.switch",
  ap: "dash.kind.ap",
  other: "dash.kind.other",
};
const STATUS_STYLE: Record<string, string> = {
  up: "bg-success-soft text-success",
  down: "bg-danger-soft text-danger",
  unknown: "bg-surface-2 text-text-2",
};
const STATUS_LABEL: Record<string, TextKey> = {
  up: "dash.status.up",
  down: "dash.status.down",
  unknown: "dash.status.unknown",
};

// Stałe poza komponentem: wykres odrysowuje się tylko przy zmianie danych, nie przy każdym renderze
const TRAFFIC_SERIES: ChartSeries[] = [
  { key: "in_bps", name: t("chart.traffic.in"), color: 1 },
  { key: "out_bps", name: t("chart.traffic.out"), color: 2 },
];
const WIFI_SERIES: ChartSeries[] = [{ key: "clients", name: t("chart.wifi.clients"), color: 3 }];
const formatClients = (v: number) => String(Math.round(v * 10) / 10);

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

function RangePicker() {
  const { rangeMinutes, setRangeMinutes } = useRefresh();
  return (
    <div role="group" aria-label={t("dash.range")} className="inline-flex rounded-lg border border-border bg-surface p-0.5">
      {RANGE_OPTIONS.map((m) => (
        <button
          key={m}
          type="button"
          aria-pressed={m === rangeMinutes}
          onClick={() => setRangeMinutes(m)}
          className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
            m === rangeMinutes ? "bg-accent-soft font-medium text-accent" : "text-text-2 hover:text-text"
          }`}
        >
          {formatRange(m)}
        </button>
      ))}
    </div>
  );
}

function DeviceCard({ device }: { device: Device }) {
  const Icon = KIND_ICON[device.kind as keyof typeof KIND_ICON] ?? IconDeviceDesktop;
  const status = device.status in STATUS_STYLE ? device.status : "unknown";
  const polled = relativeTime(device.last_polled_at);
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <Icon size={22} aria-hidden="true" className="shrink-0 text-text-2" />
          <div className="min-w-0">
            <h3 className="truncate text-sm font-medium">{device.name}</h3>
            <p className="truncate text-xs text-text-2">
              {device.host} · {t(KIND_LABEL[device.kind] ?? "dash.kind.other")}
            </p>
          </div>
        </div>
        <span className={`shrink-0 rounded-md px-2 py-0.5 text-xs ${STATUS_STYLE[status]}`}>{t(STATUS_LABEL[status])}</span>
      </div>
      <dl className="flex justify-between gap-3 text-xs text-text-2">
        <div className="min-w-0">
          <dt className="sr-only">Model</dt>
          <dd className="truncate">{[device.vendor, device.model].filter(Boolean).join(" ") || "-"}</dd>
        </div>
        <div className="shrink-0 text-right">
          <dt className="sr-only">{t("dash.polled")}</dt>
          <dd>{polled ?? t("dash.never")}</dd>
        </div>
      </dl>
      {device.status === "down" && device.last_error && (
        <p className="truncate text-xs text-danger" title={device.last_error}>
          {device.last_error}
        </p>
      )}
    </Card>
  );
}

/** Pulpit: podsumowanie sieci, wykresy ruchu WAN i klientów WiFi, karty urządzeń. */
export function DashboardPage() {
  const summary = useDashboardSummary();
  const devices = useDevices();
  const traffic = useSeries("traffic");
  const wifi = useSeries("wifi");

  const s = summary.data;
  const list = devices.data ?? [];
  const noDevices = !devices.isLoading && !devices.isError && list.length === 0;

  return (
    <>
      <PageHeader title={t("dash.title")}>
        <RangePicker />
      </PageHeader>

      {(summary.isError || devices.isError) && !s && <ErrorNote>{t("dash.error")}</ErrorNote>}

      {noDevices && (
        <Card className="mb-4 p-6">
          <h2 className="text-base font-medium">{t("dash.empty.title")}</h2>
          <p className="mt-1 text-sm text-text-2">{t("dash.empty.body")}</p>
          <code className="mt-3 block overflow-x-auto rounded-lg bg-surface-2 px-3 py-2 font-mono text-xs">
            netpulse device add &quot;UCG Ultra&quot; 192.168.1.1 --community public
          </code>
        </Card>
      )}

      {s && !noDevices && (
        <div className="mb-4 grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-3">
          <Metric
            label={t("dash.devices")}
            value={`${s.devices.up} ${t("dash.of", { total: s.devices.total })}`}
            tone={s.devices.down > 0 ? "danger" : s.devices.up > 0 ? "success" : undefined}
            note={s.devices.down > 0 ? `${s.devices.down} ${t("dash.down").toLowerCase()}` : t("dash.up")}
          />
          <Metric label={t("dash.wanDown")} value={formatBps(s.wan.in_bps)} />
          <Metric label={t("dash.wanUp")} value={formatBps(s.wan.out_bps)} />
          <Metric label={t("dash.wifiClients")} value={s.wifi_clients ?? "–"} />
        </div>
      )}

      {!noDevices && (
        <div className="mb-6 grid gap-3 lg:grid-cols-3">
          <ChartCard
            className="lg:col-span-2"
            title={t("chart.traffic.title")}
            series={TRAFFIC_SERIES}
            data={traffic.data}
            isLoading={traffic.isLoading}
            isError={traffic.isError}
            format={formatBps}
          />
          <ChartCard
            title={t("chart.wifi.title")}
            series={WIFI_SERIES}
            data={wifi.data}
            isLoading={wifi.isLoading}
            isError={wifi.isError}
            format={formatClients}
          />
        </div>
      )}

      {list.length > 0 && (
        <section aria-labelledby="devices-heading">
          <h2 id="devices-heading" className="mb-3 text-sm font-medium text-text-2">
            {t("dash.devicesTitle")}
          </h2>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3">
            {list.map((d) => (
              <DeviceCard key={d.id} device={d} />
            ))}
          </div>
        </section>
      )}
    </>
  );
}
