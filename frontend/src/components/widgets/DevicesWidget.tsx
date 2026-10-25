import { IconAccessPoint, IconDeviceDesktop, IconNetwork, IconRouter, IconServer2 } from "@tabler/icons-react";
import { Link } from "react-router";
import { t, type TextKey } from "../../i18n";
import type { Device } from "../../lib/api";
import { useDevicesAvailability } from "../../lib/details";
import { useDetailLinks } from "../../lib/publicMode";
import { formatAvailability } from "../../lib/wan";
import { relativeTime } from "../../lib/format";
import type { DeviceKind } from "../../lib/layout";
import { useDevices } from "../../lib/queries";
import { Card } from "../ui";
import { ServerDetails } from "./ServerDetails";

export const KIND_ICON = { gateway: IconRouter, switch: IconNetwork, ap: IconAccessPoint, server: IconServer2 } as const;
export const KIND_LABEL: Record<string, TextKey> = {
  gateway: "dash.kind.gateway",
  switch: "dash.kind.switch",
  ap: "dash.kind.ap",
  server: "dash.kind.server",
  other: "dash.kind.other",
};
export const STATUS_STYLE: Record<string, string> = {
  up: "bg-success-soft text-success",
  down: "bg-danger-soft text-danger",
  unknown: "bg-surface-2 text-text-2",
};
export const STATUS_LABEL: Record<string, TextKey> = {
  up: "dash.status.up",
  down: "dash.status.down",
  unknown: "dash.status.unknown",
};

export function deviceIcon(kind: string) {
  return KIND_ICON[kind as keyof typeof KIND_ICON] ?? IconDeviceDesktop;
}

function DeviceCard({ device, availability }: { device: Device; availability: number | null | undefined }) {
  const Icon = deviceIcon(device.kind);
  const status = device.status in STATUS_STYLE ? device.status : "unknown";
  const polled = relativeTime(device.last_polled_at);
  const linked = useDetailLinks();
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <Icon size={22} aria-hidden="true" className="shrink-0 text-text-2" />
          <div className="min-w-0">
            <h3 className="truncate text-sm font-medium">
              {linked ? (
                <Link to={`/devices/${device.id}`} className="hover:text-accent hover:underline">
                  {device.name}
                </Link>
              ) : (
                device.name
              )}
            </h3>
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
      {availability != null && (
        <p className="text-xs text-text-2">
          {t("avail.card", { value: formatAvailability(availability) })}
        </p>
      )}
      {device.kind === "server" && device.status !== "down" && <ServerDetails deviceId={device.id} />}
      {device.status === "down" && device.last_error && (
        <p className="truncate text-xs text-danger" title={device.last_error}>
          {device.last_error}
        </p>
      )}
    </Card>
  );
}

/** Karty urządzeń (opcjonalnie tylko wybrane typy). */
export function DevicesWidget({ kinds }: { kinds?: DeviceKind[] | null }) {
  const { data } = useDevices();
  const availability = useDevicesAvailability(30);
  const list = (data ?? []).filter((d) => !kinds?.length || kinds.includes((d.kind as DeviceKind) ?? "other"));
  if (list.length === 0) return null;
  return (
    <section aria-labelledby="devices-heading">
      <h2 id="devices-heading" className="mb-3 text-sm font-medium text-text-2">
        {t("dash.devicesTitle")}
      </h2>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3">
        {list.map((d) => (
          <DeviceCard key={d.id} device={d} availability={availability.data?.[d.id]} />
        ))}
      </div>
    </section>
  );
}
