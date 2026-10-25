import { IconDeviceDesktop } from "@tabler/icons-react";
import { Card } from "../components/ui";
import { t } from "../i18n";
import { formatUptime } from "../lib/format";
import { useClients } from "../lib/unifi";
import { Connection } from "./ClientsPage";

/** Klienci podłączeni do urządzenia (AP albo switch) albo do jednego portu switcha – z kontrolera UniFi. */
export function ClientList({ deviceId, port, title }: { deviceId: number; port?: number | null; title: string }) {
  const { data } = useClients();
  const list = (data ?? []).filter((c) => c.uplink_device_id === deviceId && (port == null || (c.is_wired && c.uplink_port === port)));
  if (list.length === 0) return null;
  return (
    <Card className="overflow-x-auto">
      <h2 className="px-4 pt-4 text-sm font-medium">
        {title} ({list.length})
      </h2>
      <table className="mt-2 w-full min-w-[32rem] text-left text-sm">
        <thead className="text-xs text-text-2">
          <tr>
            <th scope="col" className="px-4 py-2 font-medium">{t("clients.col.name")}</th>
            <th scope="col" className="px-4 py-2 font-medium">{t("clients.col.ip")}</th>
            <th scope="col" className="px-4 py-2 font-medium">{t("clients.col.connection")}</th>
            <th scope="col" className="px-4 py-2 font-medium">{t("clients.col.time")}</th>
          </tr>
        </thead>
        <tbody>
          {list.map((c) => (
            <tr key={c.mac} className="border-t border-border">
              <td className="px-4 py-2">
                <span className="flex items-center gap-2">
                  <IconDeviceDesktop size={16} aria-hidden="true" className="shrink-0 text-text-2" />
                  <span className="truncate font-medium">{c.name ?? c.mac}</span>
                </span>
              </td>
              <td className="px-4 py-2 text-text-2">{c.ip ?? "–"}</td>
              <td className="px-4 py-2">
                <Connection c={c} />
              </td>
              <td className="px-4 py-2 text-text-2">{formatUptime(c.connected_s)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
