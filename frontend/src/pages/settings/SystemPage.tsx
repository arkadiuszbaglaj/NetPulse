import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { ChartWidget } from "../../components/widgets/ChartWidget";
import { ServerWidget } from "../../components/widgets/ServerWidget";
import { Card, ErrorNote, PageHeader } from "../../components/ui";
import { t, type TextKey } from "../../i18n";
import { get } from "../../lib/api";
import { newChartConfig, type ChartConfig } from "../../lib/layout";
import { useRefresh } from "../../lib/refresh";

interface Service {
  id: string;
  state: "ok" | "warn" | "down" | "off";
  detail: string | null;
}

const NAME: Record<string, TextKey> = {
  api: "sys.svc.api",
  database: "sys.svc.database",
  collector: "sys.svc.collector",
  unifi: "sys.svc.unifi",
  updater: "sys.svc.updater",
};
const STATE_LABEL: Record<Service["state"], TextKey> = {
  ok: "sys.state.ok",
  warn: "sys.state.warn",
  down: "sys.state.down",
  off: "sys.state.off",
};
const DOT: Record<Service["state"], string> = {
  ok: "bg-success",
  warn: "bg-warning",
  down: "bg-danger",
  off: "bg-muted",
};
const DETAIL: Record<string, TextKey> = {
  not_configured: "sys.detail.not_configured",
  unreachable: "sys.detail.unreachable",
  no_data: "sys.detail.no_data",
  no_database: "sys.detail.no_database",
  stale: "sys.detail.stale",
  timescaledb: "sys.detail.timescaledb",
  postgres: "sys.detail.postgres",
};

/** Opis stanu usługi: znany kod tłumaczymy, wersję i komunikat błędu pokazujemy tak, jak przyszły. */
function detailText(s: Service): string | null {
  if (!s.detail) return null;
  if (s.id === "api") return t("sys.detail.version", { version: s.detail });
  const key = DETAIL[s.detail];
  return key ? t(key) : s.detail;
}

function useServices() {
  const { refetchInterval } = useRefresh();
  return useQuery({
    queryKey: ["system", "services"],
    queryFn: () => get<Service[]>("/api/system/services"),
    refetchInterval,
  });
}

const chart = (title: string, keys: string[], height: ChartConfig["height"] = "md"): ChartConfig => ({
  ...newChartConfig({ kind: "server" }),
  title,
  series: keys.map((key, i) => ({ key, color: ((i % 4) + 1) as 1 | 2 | 3 | 4 })),
  height,
});

/** Ustawienia → System: stan usług NetPulse, bieżący stan serwera i jego wykresy. */
export function SystemPage() {
  const services = useServices();
  const charts = useMemo(
    () => [
      chart(t("sys.chart.usage"), ["cpu_percent", "mem_used_percent", "disk_used_percent"]),
      chart(t("sys.chart.load"), ["load1"]),
      chart(t("sys.chart.temp"), ["temp_c"]),
      chart(t("sys.chart.db"), ["db_size_bytes"]),
    ],
    [],
  );
  // Zajętość to procenty, więc oś zawsze 0–100
  const usage = { ...charts[0], y_max: 100 };

  return (
    <>
      <PageHeader title={t("sys.title")} />
      <p className="mb-4 max-w-2xl text-sm text-text-2">{t("sys.intro")}</p>

      <section aria-labelledby="sys-services" className="mb-6">
        <h2 id="sys-services" className="mb-2 text-sm font-medium text-text-2">
          {t("sys.services")}
        </h2>
        {services.isError && <ErrorNote>{t("sys.error")}</ErrorNote>}
        <Card>
          <ul className="divide-y divide-border">
            {(services.data ?? []).map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm">
                <span aria-hidden="true" className={`size-2.5 shrink-0 rounded-full ${DOT[s.state]}`} />
                <span className="font-medium">{t(NAME[s.id] ?? "sys.svc.api")}</span>
                <span className="text-text-2">{t(STATE_LABEL[s.state])}</span>
                {detailText(s) && <span className="min-w-0 truncate text-xs text-text-2">{detailText(s)}</span>}
              </li>
            ))}
          </ul>
        </Card>
      </section>

      <div className="grid gap-3 lg:grid-cols-12">
        <div className="lg:col-span-4">
          <ServerWidget />
        </div>
        <div className="grid gap-3 lg:col-span-8">
          <ChartWidget config={usage} />
          <div className="grid gap-3 sm:grid-cols-3">
            <ChartWidget config={{ ...charts[1], height: "sm" }} />
            <ChartWidget config={{ ...charts[2], height: "sm" }} />
            <ChartWidget config={{ ...charts[3], height: "sm" }} />
          </div>
        </div>
      </div>
    </>
  );
}
