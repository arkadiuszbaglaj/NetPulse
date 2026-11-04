/** Kafelek „VPN” (od 0.57.0): serwery VPN bramy UniFi i klienci – kto jest połączony, od kiedy, skąd i z jakim ruchem;
 * rozłączeni z czasem ostatniego połączenia. Dane z kontrolera UniFi (co cykl kolektora UniFi). */
import { IconShieldLock } from "@tabler/icons-react";
import { t } from "../../i18n";
import { formatBps, formatBytes, relativeTime } from "../../lib/format";
import { useRefresh } from "../../lib/refresh";
import { useVpn, type VpnUser } from "../../lib/vpn";
import { Card, ErrorNote } from "../ui";

function UserRow({ user }: { user: VpnUser }) {
  const when = user.connected ? relativeTime(user.since) : relativeTime(user.last_seen);
  const transfer = user.down_bytes != null || user.up_bytes != null ? `↓ ${formatBytes(user.down_bytes)} · ↑ ${formatBytes(user.up_bytes)}` : null;
  const addr = [user.tunnel_ip, user.remote_ip && t("vpn.from", { ip: user.remote_ip })].filter(Boolean).join(" · ");
  return (
    <li className="flex items-start gap-3 border-t border-border/60 py-2.5 first:border-t-0 first:pt-0">
      <span
        role="img"
        aria-label={t(user.connected ? "vpn.connected" : "vpn.offline")}
        className={`mt-1.5 inline-block size-2.5 shrink-0 rounded-full ${user.connected ? "bg-success" : "bg-border-strong"}`}
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium" title={user.name}>
          {user.name}
        </p>
        <p className={`text-xs ${user.connected ? "text-success" : "text-text-2"}`}>
          {user.connected
            ? when ? t("vpn.connectedSince", { when }) : t("vpn.connected")
            : when ? t("vpn.lastSeen", { when }) : t("vpn.never")}
        </p>
        {addr && <p className="truncate text-xs text-muted" title={addr}>{addr}</p>}
        {transfer && (
          <p className="text-xs text-muted" title={t(user.connected ? "vpn.transfer.now" : "vpn.transfer.last")}>
            {transfer}
          </p>
        )}
      </div>
      {user.connected && (
        <p className="shrink-0 text-right text-xs text-text-2">
          <span className="block" title={t("vpn.down")}>↓ {formatBps(user.down_bps)}</span>
          <span className="block" title={t("vpn.up")}>↑ {formatBps(user.up_bps)}</span>
        </p>
      )}
    </li>
  );
}

export function VpnWidget({ title, showOffline }: { title: string | null; showOffline: boolean }) {
  const { refetchInterval } = useRefresh();
  const { data, isError, isLoading } = useVpn(refetchInterval);
  const users = (data?.users ?? []).filter((u) => showOffline || u.connected);
  const online = (data?.users ?? []).filter((u) => u.connected).length;
  const servers = data?.servers ?? [];
  return (
    <Card className="flex h-full flex-col p-5">
      <div className="flex items-baseline justify-between gap-3 pb-3">
        <h2 className="flex min-w-0 items-center gap-2 text-base font-semibold">
          <IconShieldLock size={18} aria-hidden="true" className="shrink-0 text-text-2" />
          <span className="truncate">{title || t("widget.type.vpn")}</span>
        </h2>
        {data && data.users.length > 0 && <span className="shrink-0 text-xs text-text-2">{t("vpn.online", { n: online, total: data.users.length })}</span>}
      </div>
      {isError && <ErrorNote>{t("dash.error")}</ErrorNote>}
      {isLoading && <p className="text-sm text-muted">{t("app.loading")}</p>}
      {data && servers.length > 0 && (
        <p className="pb-3 text-xs text-text-2">
          {servers.map((s) => [s.name, s.type, s.port && `UDP ${s.port}`, s.subnet].filter(Boolean).join(" · ")).join(" | ")}
        </p>
      )}
      {data?.stale && <p className="pb-2 text-xs text-warning">{t("vpn.stale", { when: relativeTime(data.at) ?? "" })}</p>}
      {data && servers.length === 0 && users.length === 0 && <p className="text-sm text-muted">{t("vpn.none")}</p>}
      {data && servers.length > 0 && users.length === 0 && <p className="text-sm text-muted">{t(showOffline ? "vpn.noUsers" : "vpn.nobody")}</p>}
      <ul className="flex flex-col">
        {users.map((u) => (
          <UserRow key={u.name} user={u} />
        ))}
      </ul>
    </Card>
  );
}
