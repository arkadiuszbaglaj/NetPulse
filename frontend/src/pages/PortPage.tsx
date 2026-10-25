import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useParams } from "react-router";
import { AvailabilityCard } from "../components/Availability";
import { ChartCard } from "../components/charts/ChartCard";
import { RangePicker } from "../components/RangePicker";
import { Card, ErrorNote, PageHeader } from "../components/ui";
import { ChartWidget } from "../components/widgets/ChartWidget";
import { bucketSeconds } from "../components/widgets/chartSource";
import { t } from "../i18n";
import { ApiError, get, type SeriesPoint } from "../lib/api";
import { formatSpeed, useInterface, type InterfaceDetail } from "../lib/details";
import { formatBps, relativeTime } from "../lib/format";
import { newChartConfig, type ChartConfig } from "../lib/layout";
import { isOn, useModules } from "../lib/modules";
import { useRefresh } from "../lib/refresh";
import { formatWatts, usePoe } from "../lib/unifi";
import { ClientList } from "./ClientList";
import { BackLink, OperBadge } from "./DevicePage";

const ROLE_LABEL = { wan: "port.role.wan", lan: "port.role.lan", port: "port.role.port", virtual: "port.role.virtual" } as const;

function PortInfo({ port, poeW }: { port: InterfaceDetail; poeW: number | null | undefined }) {
  const rows: [string, string][] = [
    [t("port.info.name"), port.name],
    [t("port.info.role"), t(ROLE_LABEL[port.role as keyof typeof ROLE_LABEL] ?? "port.role.port")],
    [t("device.ports.speed"), port.oper_status === "up" ? formatSpeed(port.speed_mbps) : "–"],
    [t("port.in"), formatBps(port.in_bps)],
    [t("port.out"), formatBps(port.out_bps)],
    ["MAC", port.mac ?? "–"],
    [t("port.info.seen"), relativeTime(port.last_seen_at) ?? "–"],
  ];
  if (port.poe_port_idx != null && poeW !== undefined) rows.splice(5, 0, [t("port.info.poe"), formatWatts(poeW)]);
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

/** Moc PoE na porcie w czasie (dane z kontrolera UniFi). */
function PoeChart({ interfaceId }: { interfaceId: number }) {
  const { refetchInterval, rangeMinutes } = useRefresh();
  const query = useQuery({
    queryKey: ["interface-poe", interfaceId, rangeMinutes],
    queryFn: async () => ({
      interval_s: bucketSeconds(rangeMinutes),
      points: await get<SeriesPoint[]>(`/api/interfaces/${interfaceId}/poe-metrics?minutes=${rangeMinutes}`),
    }),
    refetchInterval,
    placeholderData: (previous) => previous,
  });
  return (
    <ChartCard
      title={t("port.chart.poe")}
      series={[{ key: "power_w", name: t("port.chart.power"), color: 5 }]}
      data={query.data}
      isLoading={query.isLoading}
      isError={query.isError}
      format={(v) => formatWatts(v)}
      kind="line"
    />
  );
}

/** Szczegóły portu: stan, dostępność łącza, ruch, błędy, PoE i klienci podłączeni do tego portu. */
export function PortPage() {
  const params = useParams();
  const deviceId = Number(params.deviceId);
  const id = Number(params.interfaceId);
  const port = useInterface(id);
  const unifi = isOn(useModules().data, "unifi");
  const poeIdx = port.data?.poe_port_idx ?? null;
  const poe = usePoe(unifi && poeIdx != null ? deviceId : null);
  const poeNow = poe.data ? (poe.data.ports.find((p) => p.port_idx === poeIdx)?.power_w ?? null) : undefined;

  const [traffic, errors] = useMemo((): [ChartConfig, ChartConfig] => {
    const source = { kind: "interface", id, device_id: deviceId } as const;
    return [
      { ...newChartConfig(source), title: t("port.chart.traffic") },
      {
        ...newChartConfig(source, [
          { key: "in_errors", color: 6 },
          { key: "out_errors", color: 7 },
          { key: "in_discards", color: 3 },
          { key: "out_discards", color: 4 },
        ]),
        title: t("port.chart.errors"),
        chart: "line",
      },
    ];
  }, [id, deviceId]);

  const back = `/devices/${deviceId}`;
  if (port.isError) {
    const missing = port.error instanceof ApiError && port.error.status === 404;
    return (
      <>
        <BackLink to={back} label={t("nav.device")} />
        <ErrorNote>{t(missing ? "port.missing" : "port.error")}</ErrorNote>
      </>
    );
  }
  const p = port.data;
  if (!p) return <p role="status" className="py-10 text-center text-sm text-text-2">{t("app.loading")}</p>;

  return (
    <>
      <BackLink to={back} label={p.device_name} />
      <PageHeader title={`${p.label || p.name} · ${p.device_name}`}>
        <OperBadge status={p.oper_status} />
      </PageHeader>
      {p.alias && <p className="-mt-3 mb-4 text-sm text-text-2">{p.alias}</p>}

      <div className="flex flex-col gap-3">
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          <PortInfo port={p} poeW={poeNow} />
          <AvailabilityCard kind="interfaces" id={id} title={t("port.availability")} />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium text-text-2">{t("device.history")}</h2>
          <RangePicker />
        </div>
        <div className="grid gap-3 lg:grid-cols-2">
          <ChartWidget config={traffic} />
          <ChartWidget config={errors} />
          {unifi && poeIdx != null && <PoeChart interfaceId={id} />}
        </div>

        {unifi && poeIdx != null && <ClientList deviceId={deviceId} port={poeIdx} title={t("port.clients")} />}
      </div>
    </>
  );
}
