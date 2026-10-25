import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { ChartCard } from "../components/charts/ChartCard";
import { RangePicker } from "../components/RangePicker";
import { Card, ErrorNote, PageHeader } from "../components/ui";
import { bucketSeconds } from "../components/widgets/chartSource";
import { t } from "../i18n";
import { ApiError, get, type SeriesPoint } from "../lib/api";
import {
  clientMetricsPath,
  presenceTimeline,
  radioLabel,
  useClient,
  useClientEvents,
  useClientPresence,
  type ClientDetail,
  type ClientEvent,
} from "../lib/clients";
import { formatDateTime, formatRange, formatUptime, relativeTime } from "../lib/format";
import { useRefresh } from "../lib/refresh";
import { formatLinkRate, signalQuality } from "../lib/unifi";
import { formatAvailability, formatDuration } from "../lib/wan";
import { BackLink } from "./DevicePage";

const QUALITY_LABEL = {
  great: "clients.signal.great",
  good: "clients.signal.good",
  fair: "clients.signal.fair",
  weak: "clients.signal.weak",
} as const;

function UplinkLink({ id, name, port }: { id: number | null; name: string | null; port: number | null }) {
  const text = `${name ?? "–"}${port != null ? ` · ${t("clients.port", { n: port })}` : ""}`;
  return id != null ? (
    <Link to={`/devices/${id}`} className="hover:text-accent hover:underline">
      {text}
    </Link>
  ) : (
    <>{text}</>
  );
}

function InfoCard({ client }: { client: ClientDetail }) {
  const c = client.current;
  const quality = signalQuality(c?.signal_dbm ?? null);
  const rows: [string, React.ReactNode][] = [
    ["MAC", client.mac],
    [t("clients.col.ip"), client.ip ?? "–"],
    [t("client.type"), t(client.is_wired ? "client.wired" : "client.wifi")],
  ];
  if (c && !c.is_wired) {
    rows.push(
      [t("client.network"), [c.essid, radioLabel(c.radio)].filter(Boolean).join(" · ") || "–"],
      [t("client.signal"), c.signal_dbm != null ? `${c.signal_dbm} dBm${quality ? ` (${t(QUALITY_LABEL[quality])})` : ""}` : "–"],
      [t("clients.col.rate"), `${formatLinkRate(c.rx_rate_kbps)} / ${formatLinkRate(c.tx_rate_kbps)}`],
    );
  }
  if (c) {
    rows.push([t("client.uplink"), <UplinkLink key="uplink" id={c.uplink_device_id} name={c.uplink_name} port={c.uplink_port} />]);
    rows.push([t("clients.col.time"), formatUptime(c.connected_s)]);
  }
  rows.push([t("client.firstSeen"), formatDateTime(client.first_seen_at)], [t("client.lastSeen"), relativeTime(client.last_seen_at) ?? "–"]);
  return (
    <Card className="p-4">
      <h2 className="mb-3 text-sm font-medium">{t("device.info.title")}</h2>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-text-2">{label}</dt>
            <dd className="min-w-0 truncate">{value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

const slotTime = new Intl.DateTimeFormat("pl", { dateStyle: "short", timeStyle: "short" });

function PresenceCard({ mac }: { mac: string }) {
  const { rangeMinutes } = useRefresh();
  const { data } = useClientPresence(mac, rangeMinutes);
  const slots = data ? presenceTimeline(data, rangeMinutes) : [];
  const share = slots.length ? (slots.reduce((sum, s) => sum + s.share, 0) / slots.length) * 100 : null;
  return (
    <Card className="p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium">{t("client.presence")}</h2>
        {share != null && <p className="text-sm text-text-2">{t("client.presence.share", { value: formatAvailability(share), range: formatRange(rangeMinutes) })}</p>}
      </div>
      {slots.length > 0 && (
        <ol aria-label={t("client.presence.timeline")} className="flex h-6 items-stretch">
          {slots.map((s) => (
            <li
              key={s.start}
              title={`${slotTime.format(s.start)}: ${t(s.share > 0 ? "client.online" : "client.offline")}`}
              className={`min-w-0 flex-1 ${s.share >= 0.5 ? "bg-success" : s.share > 0 ? "bg-success-soft" : "bg-surface-2"}`}
            />
          ))}
        </ol>
      )}
    </Card>
  );
}

function MetricsCharts({ mac, wired }: { mac: string; wired: boolean }) {
  const { refetchInterval, rangeMinutes } = useRefresh();
  const query = useQuery({
    queryKey: ["client-metrics", mac, rangeMinutes],
    queryFn: async () => ({ interval_s: bucketSeconds(rangeMinutes), points: await get<SeriesPoint[]>(clientMetricsPath(mac, rangeMinutes)) }),
    refetchInterval,
    placeholderData: (previous) => previous,
  });
  if (wired) return null; // klient po kablu: kontroler nie podaje sygnału ani prędkości łącza
  const common = { data: query.data, isLoading: query.isLoading, isError: query.isError, kind: "line" as const };
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <ChartCard {...common} title={t("client.chart.signal")} series={[{ key: "signal_dbm", name: t("client.signal"), color: 3 }]} format={(v) => `${Math.round(v)} dBm`} />
      <ChartCard
        {...common}
        title={t("client.chart.rate")}
        series={[
          { key: "rx_rate_kbps", name: t("client.chart.rx"), color: 1 },
          { key: "tx_rate_kbps", name: t("client.chart.tx"), color: 2 },
        ]}
        format={(v) => formatLinkRate(Math.round(v))}
      />
    </div>
  );
}

function eventText(e: ClientEvent): string {
  const where = [e.uplink_name, e.essid, radioLabel(e.radio)].filter(Boolean).join(" · ") || "–";
  if (e.kind === "roam") return t("client.event.roam", { where });
  if (e.kind === "band") return t("client.event.band", { band: radioLabel(e.radio) ?? "–", where });
  return e.gap_s != null ? t("client.event.back", { where, gap: formatDuration(e.gap_s) }) : t("client.event.connect", { where });
}

function EventsCard({ mac }: { mac: string }) {
  const { rangeMinutes } = useRefresh();
  const { data } = useClientEvents(mac, rangeMinutes);
  return (
    <Card className="p-4">
      <h2 className="mb-3 text-sm font-medium">{t("client.events")}</h2>
      {!data?.length ? (
        <p className="text-sm text-text-2">{t("client.events.empty", { range: formatRange(rangeMinutes) })}</p>
      ) : (
        <ol className="flex flex-col gap-2 text-sm">
          {data.map((e) => (
            <li key={`${e.time}-${e.kind}`} className="flex flex-wrap gap-x-3">
              <time dateTime={e.time} className="shrink-0 text-text-2 tabular-nums">
                {formatDateTime(e.time)}
              </time>
              <span>{eventText(e)}</span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

/** Szczegóły klienta sieci: stan teraz, obecność w sieci, sygnał i prędkość w czasie, przejścia między AP. */
export function ClientPage() {
  const mac = (useParams().mac ?? "").toLowerCase();
  const client = useClient(mac);

  if (client.isError) {
    const missing = client.error instanceof ApiError && (client.error.status === 404 || client.error.status === 422);
    return (
      <>
        <BackLink to="/clients" label={t("nav.clients")} />
        <ErrorNote>{t(missing ? "client.missing" : "client.error")}</ErrorNote>
      </>
    );
  }
  const c = client.data;
  if (!c) return <p role="status" className="py-10 text-center text-sm text-text-2">{t("app.loading")}</p>;

  return (
    <>
      <BackLink to="/clients" label={t("nav.clients")} />
      <PageHeader title={c.name ?? c.mac}>
        <div className="flex flex-wrap items-center gap-2">
          {c.is_guest && <span className="rounded-md bg-surface-2 px-2 py-0.5 text-xs text-text-2">{t("clients.guest")}</span>}
          <span className={`rounded-md px-2 py-0.5 text-xs ${c.online ? "bg-success-soft text-success" : "bg-surface-2 text-text-2"}`}>
            {t(c.online ? "client.online" : "client.offline")}
          </span>
        </div>
      </PageHeader>

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium text-text-2">{t("device.history")}</h2>
          <RangePicker />
        </div>
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          <InfoCard client={c} />
          <div className="flex min-w-0 flex-col gap-3">
            <PresenceCard mac={mac} />
            <EventsCard mac={mac} />
          </div>
        </div>
        <MetricsCharts mac={mac} wired={c.is_wired} />
      </div>
    </>
  );
}
