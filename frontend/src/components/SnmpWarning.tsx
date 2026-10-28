import { IconAlertTriangle } from "@tabler/icons-react";
import { Link } from "react-router";
import { t } from "../i18n";
import type { Device } from "../lib/api";
import { useDevices } from "../lib/queries";

/** Plakietka przy urządzeniu z fabrycznym community SNMP („public”, „private”). */
export function DefaultCommunityBadge({ device }: { device: Pick<Device, "default_community"> }) {
  if (!device.default_community) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-warning-soft px-2 py-0.5 text-xs text-warning" title={t("snmp.default.hint")}>
      <IconAlertTriangle size={14} aria-hidden="true" />
      {t("snmp.default.badge")}
    </span>
  );
}

/** Ostrzeżenie na stronie System: urządzenia z fabrycznym community i co z tym zrobić. */
export function DefaultCommunityNote() {
  const devices = (useDevices().data ?? []).filter((d) => d.enabled && d.default_community);
  if (devices.length === 0) return null;
  return (
    <div role="status" className="mb-6 flex gap-3 rounded-xl border border-warning/40 bg-warning-soft p-4 text-sm">
      <IconAlertTriangle size={20} aria-hidden="true" className="mt-0.5 shrink-0 text-warning" />
      <div>
        <p className="font-medium">{t("snmp.default.title", { n: devices.length })}</p>
        <p className="mt-1 text-text-2">{devices.map((d) => d.name).join(", ")}</p>
        <p className="mt-2 max-w-2xl text-text-2">{t("snmp.default.body")}</p>
        <Link to="/settings/devices" className="mt-2 inline-block text-accent hover:underline">
          {t("snmp.default.link")}
        </Link>
      </div>
    </div>
  );
}
