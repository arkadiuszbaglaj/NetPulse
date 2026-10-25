import { useQuery } from "@tanstack/react-query";
import { t } from "../../i18n";
import { get } from "../../lib/api";
import { formatBytes, formatUptime } from "../../lib/format";
import { useRefresh } from "../../lib/refresh";
import { UsageBar } from "./ServerWidget";

export interface ServerDisk {
  mount: string;
  total_bytes: number;
  used_bytes: number;
  used_percent: number;
}

export interface ServerStatus {
  sampled_at: string;
  cpu_percent: number | null;
  mem_used_percent: number | null;
  swap_used_percent: number | null;
  load1: number | null;
  uptime_s: number | null;
  processes: number | null;
  disks: ServerDisk[];
}

/** Dyski pokazywane na karcie; kolejne zostają w „…i N więcej”, bo serwer z dużą liczbą woluminów rozdmuchałby pulpit. */
export const MAX_DISKS = 4;

export function useServerStatus(deviceId: number) {
  const { refetchInterval } = useRefresh();
  return useQuery({
    queryKey: ["device-server", deviceId],
    queryFn: () => get<ServerStatus | null>(`/api/devices/${deviceId}/server`),
    refetchInterval,
  });
}

/** CPU, RAM, swap i dyski serwera Linux (dane z snmpd) – wnętrze karty urządzenia. */
export function ServerDetails({ deviceId }: { deviceId: number }) {
  const { data } = useServerStatus(deviceId);
  if (!data) return null;
  // Najbardziej zapełnione dyski na górze: o te chodzi użytkownikowi
  const disks = [...data.disks].sort((a, b) => b.used_percent - a.used_percent);
  return (
    <div className="flex flex-col gap-2.5 border-t border-border pt-3">
      <UsageBar label={t("server.cpu")} percent={data.cpu_percent} />
      <UsageBar label={t("server.ram")} percent={data.mem_used_percent} />
      {data.swap_used_percent != null && <UsageBar label={t("server.swap")} percent={data.swap_used_percent} />}
      {disks.slice(0, MAX_DISKS).map((d) => (
        <UsageBar
          key={d.mount}
          label={d.mount}
          percent={d.used_percent}
          note={t("server.free", { free: formatBytes(d.total_bytes - d.used_bytes), total: formatBytes(d.total_bytes) })}
        />
      ))}
      {disks.length > MAX_DISKS && <p className="text-xs text-text-2">{t("topo.more", { n: disks.length - MAX_DISKS })}</p>}
      <p className="text-xs text-text-2">
        {[
          data.uptime_s != null ? `${t("server.uptime")}: ${formatUptime(data.uptime_s)}` : null,
          data.processes != null ? t("server.processes", { n: data.processes }) : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
    </div>
  );
}
