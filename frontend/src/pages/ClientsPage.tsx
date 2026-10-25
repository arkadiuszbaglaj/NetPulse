import { IconDeviceDesktop, IconNetwork, IconWifi } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { Card, ErrorNote, PageHeader } from "../components/ui";
import { t, type TextKey } from "../i18n";
import { clientUrl } from "../lib/clients";
import { formatUptime } from "../lib/format";
import { formatLinkRate, signalQuality, useClients, useControllers, type NetworkClient } from "../lib/unifi";

type Filter = "all" | "wifi" | "wired";
const FILTERS: Filter[] = ["all", "wifi", "wired"];
const FILTER_LABEL: Record<Filter, TextKey> = {
  all: "clients.filter.all",
  wifi: "clients.filter.wifi",
  wired: "clients.filter.wired",
};
const QUALITY_LABEL = {
  great: "clients.signal.great",
  good: "clients.signal.good",
  fair: "clients.signal.fair",
  weak: "clients.signal.weak",
} as const satisfies Record<string, TextKey>;
const QUALITY_STYLE = {
  great: "text-success",
  good: "text-success",
  fair: "text-text-2",
  weak: "text-danger",
} as const;

export function Connection({ c }: { c: NetworkClient }) {
  if (c.is_wired) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <IconNetwork size={16} aria-hidden="true" className="shrink-0 text-text-2" />
        {c.uplink_name ?? t("clients.wired")}
        {c.uplink_port != null && ` · ${t("clients.port", { n: c.uplink_port })}`}
      </span>
    );
  }
  const quality = signalQuality(c.signal_dbm);
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5">
      <IconWifi size={16} aria-hidden="true" className="shrink-0 text-text-2" />
      {c.essid ?? "WiFi"}
      {c.radio && ` · ${c.radio === "na" ? "5 GHz" : c.radio === "ng" ? "2,4 GHz" : c.radio}`}
      {c.signal_dbm != null && quality && (
        <span className={QUALITY_STYLE[quality]} title={t(QUALITY_LABEL[quality])}>
          {" · "}
          {c.signal_dbm} dBm
        </span>
      )}
    </span>
  );
}

function ClientRow({ c }: { c: NetworkClient }) {
  return (
    <tr className="border-t border-border">
      <td className="px-4 py-2.5">
        <div className="flex items-center gap-2">
          <IconDeviceDesktop size={18} aria-hidden="true" className="shrink-0 text-text-2" />
          <div className="min-w-0">
            <Link to={clientUrl(c.mac)} className="block truncate font-medium hover:text-accent hover:underline">
              {c.name ?? c.mac}
            </Link>
            {c.name && <p className="truncate text-xs text-muted">{c.mac}</p>}
          </div>
          {c.is_guest && <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-xs text-text-2">{t("clients.guest")}</span>}
        </div>
      </td>
      <td className="px-4 py-2.5 text-text-2">{c.ip ?? "–"}</td>
      <td className="px-4 py-2.5">
        <Connection c={c} />
      </td>
      <td className="px-4 py-2.5 text-text-2">{c.is_wired ? "–" : `${formatLinkRate(c.rx_rate_kbps)} / ${formatLinkRate(c.tx_rate_kbps)}`}</td>
      <td className="px-4 py-2.5 text-text-2">{formatUptime(c.connected_s)}</td>
    </tr>
  );
}

/** Klienci sieci widziani przez kontroler UniFi: WiFi (sygnał, sieć) i po kablu (port switcha). */
export function ClientsPage() {
  const clients = useClients();
  const controllers = useControllers();
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (clients.data ?? []).filter(
      (c) =>
        (filter === "all" || (filter === "wired") === c.is_wired) &&
        (!q || [c.name, c.ip, c.mac, c.essid, c.uplink_name].some((v) => v?.toLowerCase().includes(q))),
    );
  }, [clients.data, filter, query]);

  const noController = !controllers.isLoading && !controllers.isError && (controllers.data?.length ?? 0) === 0;
  const total = clients.data?.length ?? 0;

  return (
    <>
      <PageHeader title={t("clients.title")}>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            aria-label={t("clients.search")}
            placeholder={t("clients.search")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-9 rounded-lg border border-border-strong bg-surface px-3 text-sm placeholder:text-muted focus-visible:outline-2 focus-visible:outline-accent"
          />
          <div role="group" aria-label={t("clients.filter")} className="inline-flex rounded-lg border border-border bg-surface p-0.5">
            {FILTERS.map((f) => (
              <button
                key={f}
                type="button"
                aria-pressed={f === filter}
                onClick={() => setFilter(f)}
                className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                  f === filter ? "bg-accent-soft font-medium text-accent" : "text-text-2 hover:text-text"
                }`}
              >
                {t(FILTER_LABEL[f])}
              </button>
            ))}
          </div>
        </div>
      </PageHeader>

      {clients.isError && !clients.data && <ErrorNote>{t("clients.loadError")}</ErrorNote>}

      {noController && (
        <Card className="p-6">
          <h2 className="text-base font-medium">{t("clients.noController.title")}</h2>
          <p className="mt-1 max-w-prose text-sm text-text-2">{t("clients.noController.body")}</p>
        </Card>
      )}

      {!noController && total > 0 && (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[40rem] text-left text-sm">
            <thead className="text-xs text-text-2">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">{t("clients.col.name")}</th>
                <th scope="col" className="px-4 py-2 font-medium">{t("clients.col.ip")}</th>
                <th scope="col" className="px-4 py-2 font-medium">{t("clients.col.connection")}</th>
                <th scope="col" className="px-4 py-2 font-medium">{t("clients.col.rate")}</th>
                <th scope="col" className="px-4 py-2 font-medium">{t("clients.col.time")}</th>
              </tr>
            </thead>
            <tbody>
              {list.map((c) => (
                <ClientRow key={c.mac} c={c} />
              ))}
            </tbody>
          </table>
          {list.length === 0 && <p className="px-4 py-6 text-center text-sm text-text-2">{t("clients.noMatch")}</p>}
        </Card>
      )}

      {!noController && !clients.isLoading && !clients.isError && total === 0 && (
        <Card className="p-6">
          <p className="text-sm text-text-2">{t("clients.empty")}</p>
        </Card>
      )}
      {!noController && total > 0 && (
        <p className="mt-2 text-xs text-muted">{t("clients.count", { shown: list.length, total })}</p>
      )}
    </>
  );
}
