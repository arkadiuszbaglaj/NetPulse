import { IconServer } from "@tabler/icons-react";
import { t } from "../../i18n";
import { formatBytes, formatUptime } from "../../lib/format";
import { usageTone, useSystem } from "../../lib/system";
import { Card, ErrorNote } from "../ui";

const BAR_COLOR = { ok: "bg-accent", warn: "bg-warning", danger: "bg-danger" } as const;

export function UsageBar({ label, percent, note }: { label: string; percent: number | null; note?: string }) {
  const tone = usageTone(percent);
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-text-2">{label}</span>
        <span className={tone === "danger" ? "font-medium text-danger" : "font-medium"}>
          {percent == null ? "–" : `${Math.round(percent)}%`}
        </span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent == null ? undefined : Math.round(percent)}
        className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2"
      >
        <div className={`h-full rounded-full ${BAR_COLOR[tone]}`} style={{ width: `${Math.min(100, percent ?? 0)}%` }} />
      </div>
      {note && <p className="mt-0.5 text-xs text-text-2">{note}</p>}
    </div>
  );
}

const fixed = (v: number | null) => (v == null ? "–" : v.toFixed(2).replace(".", ","));

/** Stan serwera, na którym działa NetPulse: CPU, RAM, swap, dysk, obciążenie, temperatura, baza. */
export function ServerWidget() {
  const { data, isLoading, isError } = useSystem();
  return (
    <Card className="h-full p-4">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-medium">
        <IconServer size={18} aria-hidden="true" className="shrink-0 text-accent" />
        {t("widget.type.server")}
      </h3>
      {isError ? (
        <ErrorNote>{t("server.error")}</ErrorNote>
      ) : data ? (
        <div className="flex flex-col gap-3">
          <UsageBar label={t("server.cpu")} percent={data.cpu_percent} />
          <UsageBar label={t("server.ram")} percent={data.mem_used_percent} note={data.mem_total_bytes != null ? formatBytes(data.mem_total_bytes) : undefined} />
          {data.swap_used_percent != null && <UsageBar label={t("server.swap")} percent={data.swap_used_percent} />}
          <UsageBar
            label={t("server.disk")}
            percent={data.disk_used_percent}
            note={
              data.disk_free_bytes != null && data.disk_total_bytes != null
                ? t("server.free", { free: formatBytes(data.disk_free_bytes), total: formatBytes(data.disk_total_bytes) })
                : undefined
            }
          />
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
            <dt className="text-text-2">{t("server.load")}</dt>
            <dd className="text-right">{`${fixed(data.load1)} / ${fixed(data.load5)} / ${fixed(data.load15)}`}</dd>
            <dt className="text-text-2">{t("server.uptime")}</dt>
            <dd className="text-right">{formatUptime(data.uptime_s)}</dd>
            {data.temp_c != null && (
              <>
                <dt className="text-text-2">{t("server.temp")}</dt>
                <dd className="text-right">{`${data.temp_c.toFixed(1).replace(".", ",")} °C`}</dd>
              </>
            )}
            <dt className="text-text-2">{t("server.db")}</dt>
            <dd className="text-right">{formatBytes(data.db_size_bytes)}</dd>
          </dl>
        </div>
      ) : (
        !isLoading && <p className="py-6 text-center text-sm text-text-2">{t("server.noData")}</p>
      )}
    </Card>
  );
}
