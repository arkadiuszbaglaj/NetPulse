import { IconAccessPoint, IconDeviceDesktop, IconNetwork, IconRouter } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Card, ErrorNote, PageHeader } from "../components/ui";
import { t, type TextKey } from "../i18n";
import { get, type Device } from "../lib/api";
import { relativeTime } from "../lib/format";

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

function Metric({ label, value, tone }: { label: string; value: string | number; tone?: "success" | "danger" }) {
  const color = tone === "success" ? "text-success" : tone === "danger" ? "text-danger" : "text-text";
  return (
    <Card className="px-4 py-3">
      <p className="text-xs text-text-2">{label}</p>
      <p className={`mt-0.5 text-2xl font-medium ${color}`}>{value}</p>
    </Card>
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
            <h2 className="truncate text-sm font-medium">{device.name}</h2>
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

/** Pulpit: podsumowanie i karty urządzeń. Wykresy i widgety dochodzą w kolejnych etapach. */
export function DashboardPage() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["devices"],
    queryFn: () => get<Device[]>("/api/devices"),
    refetchInterval: 30_000,
  });

  const devices = data ?? [];
  const up = devices.filter((d) => d.status === "up").length;
  const down = devices.filter((d) => d.status === "down").length;

  return (
    <>
      <PageHeader title={t("dash.title")} />
      {isError && <ErrorNote>{t("dash.error")}</ErrorNote>}
      {!isError && !isLoading && devices.length === 0 && (
        <Card className="p-6">
          <h2 className="text-base font-medium">{t("dash.empty.title")}</h2>
          <p className="mt-1 text-sm text-text-2">{t("dash.empty.body")}</p>
          <code className="mt-3 block overflow-x-auto rounded-lg bg-surface-2 px-3 py-2 font-mono text-xs">
            netpulse device add &quot;UCG Ultra&quot; 192.168.1.1 --community public
          </code>
        </Card>
      )}
      {devices.length > 0 && (
        <>
          <div className="mb-4 grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3">
            <Metric label={t("dash.devices")} value={devices.length} />
            <Metric label={t("dash.up")} value={up} tone={up > 0 ? "success" : undefined} />
            <Metric label={t("dash.down")} value={down} tone={down > 0 ? "danger" : undefined} />
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3">
            {devices.map((d) => (
              <DeviceCard key={d.id} device={d} />
            ))}
          </div>
        </>
      )}
    </>
  );
}
