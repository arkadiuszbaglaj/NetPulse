import { IconBox, IconDeviceDesktop } from "@tabler/icons-react";
import { Link } from "react-router";
import { UsageBar } from "../components/widgets/ServerWidget";
import { Card, ErrorNote, PageHeader } from "../components/ui";
import { t } from "../i18n";
import { formatBytes, formatUptime, relativeTime } from "../lib/format";
import {
  BACKUP_STALE_H,
  backupAgeHours,
  useProxmoxGuests,
  useProxmoxServers,
  useProxmoxStorages,
  type ProxmoxGuest,
} from "../lib/proxmox";

const th = "px-4 py-2 font-medium";
const td = "px-4 py-2.5";

function StatusBadge({ status }: { status: string }) {
  const running = status === "running";
  return (
    <span className={`rounded-md px-2 py-0.5 text-xs ${running ? "bg-success-soft text-success" : "bg-surface-2 text-text-2"}`}>
      {t(running ? "pve.guest.running" : status === "paused" ? "pve.guest.paused" : "pve.guest.stopped")}
    </span>
  );
}

function BackupCell({ guest }: { guest: ProxmoxGuest }) {
  const age = backupAgeHours(guest.last_backup_at);
  if (age == null) return <span className="text-text-2">{t("pve.backup.never")}</span>;
  const stale = age > BACKUP_STALE_H;
  return <span className={stale ? "font-medium text-danger" : "text-text-2"}>{relativeTime(guest.last_backup_at)}</span>;
}

function GuestRow({ g }: { g: ProxmoxGuest }) {
  const Icon = g.type === "lxc" ? IconBox : IconDeviceDesktop;
  const mem = g.mem_total ? `${formatBytes(g.mem_used ?? 0)} / ${formatBytes(g.mem_total)}` : "–";
  return (
    <tr className="border-t border-border">
      <td className={td}>
        <div className="flex items-center gap-2">
          <Icon size={18} aria-hidden="true" className="shrink-0 text-text-2" />
          <div className="min-w-0">
            <p className="truncate font-medium">{g.name}</p>
            <p className="truncate text-xs text-text-2">
              {g.type === "lxc" ? "LXC" : "VM"} {g.vmid} · {g.node}
              {g.tags ? ` · ${g.tags.replaceAll(";", ", ")}` : ""}
            </p>
          </div>
        </div>
      </td>
      <td className={td}>{g.template ? <span className="text-xs text-text-2">{t("pve.guest.template")}</span> : <StatusBadge status={g.status} />}</td>
      <td className={`${td} text-text-2`}>{g.cpu_percent != null ? `${Math.round(g.cpu_percent)}% · ${g.cpus ?? "?"} vCPU` : "–"}</td>
      <td className={`${td} text-text-2`}>{mem}</td>
      <td className={`${td} text-text-2`}>{g.uptime_s ? formatUptime(g.uptime_s) : "–"}</td>
      <td className={td}>{g.template ? "–" : <BackupCell guest={g} />}</td>
    </tr>
  );
}

/** Proxmox: maszyny VM i kontenery LXC ze wszystkich serwerów oraz zajętość magazynów. */
export function ProxmoxPage() {
  const servers = useProxmoxServers();
  const guests = useProxmoxGuests();
  const storages = useProxmoxStorages();
  const noServer = servers.data?.length === 0;
  const list = guests.data ?? [];
  const running = list.filter((g) => !g.template && g.status === "running").length;
  const total = list.filter((g) => !g.template).length;

  return (
    <>
      <PageHeader title={t("nav.proxmox")} />
      {noServer && (
        <Card className="p-6">
          <h2 className="text-base font-medium">{t("pve.page.noServer.title")}</h2>
          <p className="mt-1 max-w-prose text-sm text-text-2">
            {t("pve.page.noServer.body")}{" "}
            <Link to="/settings/proxmox" className="text-accent underline">
              {t("settings.proxmox.title")}
            </Link>
          </p>
        </Card>
      )}
      {guests.isError && <ErrorNote>{t("pve.page.error")}</ErrorNote>}

      {!noServer && (
        <div className="flex flex-col gap-6">
          <section aria-labelledby="pve-guests">
            <h2 id="pve-guests" className="mb-2 text-base font-medium">
              {t("pve.page.guests", { running, total })}
            </h2>
            <Card className="overflow-x-auto">
              <table className="w-full min-w-[44rem] text-left text-sm">
                <thead className="text-xs text-text-2">
                  <tr>
                    <th scope="col" className={th}>{t("pve.col.name")}</th>
                    <th scope="col" className={th}>{t("pve.col.status")}</th>
                    <th scope="col" className={th}>{t("pve.col.cpu")}</th>
                    <th scope="col" className={th}>{t("pve.col.mem")}</th>
                    <th scope="col" className={th}>{t("pve.col.uptime")}</th>
                    <th scope="col" className={th}>{t("pve.col.backup")}</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((g) => (
                    <GuestRow key={`${g.server_id}-${g.vmid}`} g={g} />
                  ))}
                </tbody>
              </table>
              {!guests.isLoading && list.length === 0 && <p className="px-4 py-6 text-center text-sm text-text-2">{t("pve.page.noGuests")}</p>}
            </Card>
          </section>

          <section aria-labelledby="pve-storages">
            <h2 id="pve-storages" className="mb-2 text-base font-medium">
              {t("pve.page.storages")}
            </h2>
            <Card className="p-4">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {(storages.data ?? []).map((s) => (
                  <UsageBar
                    key={`${s.server_id}-${s.node}-${s.storage}`}
                    label={`${s.storage} · ${s.shared ? t("pve.storage.shared") : s.node}`}
                    percent={s.total_bytes ? (100 * (s.used_bytes ?? 0)) / s.total_bytes : null}
                    note={
                      s.active
                        ? t("server.free", { free: formatBytes((s.total_bytes ?? 0) - (s.used_bytes ?? 0)), total: formatBytes(s.total_bytes) }) + ` · ${s.type ?? "?"}`
                        : t("pve.storage.inactive")
                    }
                  />
                ))}
              </div>
              {storages.data?.length === 0 && <p className="text-sm text-text-2">{t("pve.page.noStorages")}</p>}
            </Card>
          </section>
          <p className="max-w-prose text-xs text-text-2">{t("pve.page.hint")}</p>
        </div>
      )}
    </>
  );
}
