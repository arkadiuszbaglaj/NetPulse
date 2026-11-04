import { IconArrowLeft, IconPencil } from "@tabler/icons-react";
import { useMemo } from "react";
import { Link, useParams } from "react-router";
import { AvailabilityCard } from "../components/Availability";
import { DefaultCommunityBadge } from "../components/SnmpWarning";
import { RangePicker } from "../components/RangePicker";
import { Card, ErrorNote, PageHeader } from "../components/ui";
import { ChartWidget } from "../components/widgets/ChartWidget";
import { KIND_LABEL, STATUS_LABEL, STATUS_STYLE, deviceIcon } from "../components/widgets/DevicesWidget";
import { ServerDetails } from "../components/widgets/ServerDetails";
import { t, type TextKey } from "../i18n";
import { ApiError, type Device } from "../lib/api";
import { formatSpeed, useDevice, useInterfaces, useSensors, useWifiNetworks, type InterfaceItem, type SensorsData } from "../lib/details";
import { formatBps, formatDateTime, formatUptime, metricFormatter, relativeTime } from "../lib/format";
import { METRICS, newChartConfig, unitClassOf, type ChartConfig } from "../lib/layout";
import { isOn, useModules } from "../lib/modules";
import { formatWatts, usePoe, type PoePort } from "../lib/unifi";
import { ClientList } from "./ClientList";

export const OPER_STYLE: Record<string, string> = {
  up: "bg-success-soft text-success",
  down: "bg-surface-2 text-text-2",
};

export function OperBadge({ status }: { status: string }) {
  return (
    <span className={`rounded-md px-2 py-0.5 text-xs ${OPER_STYLE[status] ?? "bg-surface-2 text-text-2"}`}>
      {t(status === "up" ? "port.up" : status === "down" ? "port.down" : "dash.status.unknown")}
    </span>
  );
}

export function BackLink({ to, label }: { to: string; label: string }) {
  return (
    <Link to={to} className="mb-3 inline-flex items-center gap-1.5 text-sm text-text-2 hover:text-text">
      <IconArrowLeft size={16} aria-hidden="true" />
      {label}
    </Link>
  );
}

function InfoCard({ device }: { device: Device }) {
  const rows: [string, string][] = [
    [t("device.info.host"), `${device.host}${device.port !== 161 ? `:${device.port}` : ""}`],
    [t("device.info.kind"), t(KIND_LABEL[device.kind] ?? "dash.kind.other")],
    [t("device.info.model"), [device.vendor, device.model].filter(Boolean).join(" ") || "–"],
    [t("device.info.firmware"), device.firmware ?? "–"],
    [t("device.info.uptime"), formatUptime(device.uptime_s)],
    [t("device.info.driver"), device.detected_driver ?? device.driver],
    [t("device.info.polled"), relativeTime(device.last_polled_at) ?? t("dash.never")],
    [t("device.info.lastOk"), formatDateTime(device.last_ok_at)],
  ];
  return (
    <Card className="p-4">
      <h2 className="mb-3 text-sm font-medium">{t("device.info.title")}</h2>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-text-2">{label}</dt>
            <dd className="min-w-0 truncate" title={value}>
              {value}
            </dd>
          </div>
        ))}
      </dl>
      {device.status === "down" && device.last_error && (
        <p className="mt-3 text-xs text-danger" title={device.last_error}>
          {device.last_error}
        </p>
      )}
    </Card>
  );
}

function PortsCard({ deviceId, interfaces, poe }: { deviceId: number; interfaces: InterfaceItem[]; poe: Map<string, Pick<PoePort, "power_w">> }) {
  const withPoe = poe.size > 0;
  return (
    <Card className="overflow-x-auto">
      <h2 className="px-4 pt-4 text-sm font-medium">{t("device.ports.title", { n: interfaces.length })}</h2>
      <table className="mt-2 w-full min-w-[36rem] text-left text-sm">
        <thead className="text-xs text-text-2">
          <tr>
            <th scope="col" className="px-4 py-2 font-medium">{t("device.ports.port")}</th>
            <th scope="col" className="px-4 py-2 font-medium">{t("device.ports.alias")}</th>
            <th scope="col" className="px-4 py-2 font-medium">{t("device.ports.status")}</th>
            <th scope="col" className="px-4 py-2 font-medium">{t("device.ports.speed")}</th>
            <th scope="col" className="px-4 py-2 text-right font-medium">{t("port.in")}</th>
            <th scope="col" className="px-4 py-2 text-right font-medium">{t("port.out")}</th>
            {withPoe && <th scope="col" className="px-4 py-2 text-right font-medium">PoE</th>}
          </tr>
        </thead>
        <tbody>
          {interfaces.map((i) => (
            <tr key={i.id} className="border-t border-border">
              <td className="px-4 py-2">
                <Link to={`/devices/${deviceId}/ports/${i.id}`} className="font-medium hover:text-accent hover:underline">
                  {i.label || i.name}
                </Link>
                {i.label && i.label !== i.name && <span className="ml-1.5 text-xs text-muted">{i.name}</span>}
              </td>
              <td className="max-w-48 truncate px-4 py-2 text-text-2">{i.alias ?? "–"}</td>
              <td className="px-4 py-2">
                <OperBadge status={i.oper_status} />
              </td>
              <td className="px-4 py-2 text-text-2">{i.oper_status === "up" ? formatSpeed(i.speed_mbps) : "–"}</td>
              <td className="px-4 py-2 text-right tabular-nums">{formatBps(i.in_bps)}</td>
              <td className="px-4 py-2 text-right tabular-nums">{formatBps(i.out_bps)}</td>
              {withPoe && <td className="px-4 py-2 text-right tabular-nums">{poe.has(i.name) ? formatWatts(poe.get(i.name)?.power_w) : "–"}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function WifiCard({ deviceId }: { deviceId: number }) {
  const { data } = useWifiNetworks(deviceId);
  if (!data?.length) return null;
  return (
    <Card className="overflow-x-auto">
      <h2 className="px-4 pt-4 text-sm font-medium">{t("device.wifi.title")}</h2>
      <table className="mt-2 w-full min-w-[28rem] text-left text-sm">
        <thead className="text-xs text-text-2">
          <tr>
            <th scope="col" className="px-4 py-2 font-medium">SSID</th>
            <th scope="col" className="px-4 py-2 font-medium">{t("device.wifi.band")}</th>
            <th scope="col" className="px-4 py-2 font-medium">{t("device.wifi.channel")}</th>
            <th scope="col" className="px-4 py-2 text-right font-medium">{t("device.wifi.clients")}</th>
          </tr>
        </thead>
        <tbody>
          {data.map((w) => (
            <tr key={w.id} className="border-t border-border">
              <td className="px-4 py-2 font-medium">{w.ssid}</td>
              <td className="px-4 py-2 text-text-2">{w.radio === "na" ? "5 GHz" : w.radio === "ng" ? "2,4 GHz" : (w.radio ?? "–")}</td>
              <td className="px-4 py-2 text-text-2">{w.channel ?? "–"}</td>
              <td className="px-4 py-2 text-right tabular-nums">{w.clients ?? "–"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

const formatSensor = (metric: string, value: number) =>
  metric === "sensor_state" ? t("device.sensors.state", { n: value }) : metricFormatter(unitClassOf(metric), "bits")(value);
const dbm = metricFormatter("dbm", "bits");
const volt = metricFormatter("volt", "bits");
const temp = metricFormatter("temp", "bits");

function poeState(state: number | null): string {
  if (state == null) return "–";
  return state <= 5 ? t(`device.poe.state.${state}` as TextKey) : t("device.poe.state.fault", { n: state });
}

const TH = "px-4 py-2 font-medium";
const TH_NUM = "px-4 py-2 text-right font-medium";
const TD_NUM = "px-4 py-2 text-right tabular-nums";

/** Czujniki sprzętu, PoE i moduły SFP urządzenia SNMP (MikroTik): ostatnie wartości. */
function SensorsCard({ data }: { data: SensorsData }) {
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {data.sensors.length > 0 && (
        <Card className="overflow-x-auto">
          <h2 className="px-4 pt-4 text-sm font-medium">{t("device.sensors.title")}</h2>
          <table className="mt-2 w-full text-left text-sm">
            <thead className="text-xs text-text-2">
              <tr>
                <th scope="col" className={TH}>{t("device.sensors.name")}</th>
                <th scope="col" className={TH_NUM}>{t("device.sensors.value")}</th>
              </tr>
            </thead>
            <tbody>
              {data.sensors.map((s) => (
                <tr key={`${s.metric}:${s.key}`} className="border-t border-border">
                  <td className="px-4 py-2">
                    {s.key}
                    {METRICS[s.metric] && <span className="ml-1.5 text-xs text-muted">{t(METRICS[s.metric].label)}</span>}
                  </td>
                  <td className={TD_NUM}>{formatSensor(s.metric, s.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {data.poe.length > 0 && (
        <Card className="overflow-x-auto">
          <h2 className="px-4 pt-4 text-sm font-medium">{t("device.poe.title")}</h2>
          <table className="mt-2 w-full text-left text-sm">
            <thead className="text-xs text-text-2">
              <tr>
                <th scope="col" className={TH}>{t("device.poe.port")}</th>
                <th scope="col" className={TH}>{t("device.poe.state")}</th>
                <th scope="col" className={TH_NUM}>{t("device.poe.power")}</th>
                <th scope="col" className={TH_NUM}>{t("device.poe.voltage")}</th>
              </tr>
            </thead>
            <tbody>
              {data.poe.map((p) => (
                <tr key={p.port} className="border-t border-border">
                  <td className="px-4 py-2 font-medium">{p.port}</td>
                  <td className={`px-4 py-2 ${p.state != null && p.state > 3 ? "text-danger" : "text-text-2"}`}>{poeState(p.state)}</td>
                  <td className={TD_NUM}>{formatWatts(p.power_w)}</td>
                  <td className={TD_NUM}>{p.voltage_v == null ? "–" : volt(p.voltage_v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {data.sfp.length > 0 && (
        <Card className="overflow-x-auto lg:col-span-2">
          <h2 className="px-4 pt-4 text-sm font-medium">{t("device.sfp.title")}</h2>
          <table className="mt-2 w-full min-w-[32rem] text-left text-sm">
            <thead className="text-xs text-text-2">
              <tr>
                <th scope="col" className={TH}>{t("device.sfp.port")}</th>
                <th scope="col" className={TH}>{t("device.sfp.signal")}</th>
                <th scope="col" className={TH_NUM}>{t("device.sfp.rx")}</th>
                <th scope="col" className={TH_NUM}>{t("device.sfp.tx")}</th>
                <th scope="col" className={TH_NUM}>{t("device.sfp.temp")}</th>
              </tr>
            </thead>
            <tbody>
              {data.sfp.map((s) => {
                const problem = s.rx_loss ? "device.sfp.loss" : s.tx_fault ? "device.sfp.fault" : null;
                return (
                  <tr key={s.port} className="border-t border-border">
                    <td className="px-4 py-2 font-medium">{s.port}</td>
                    <td className={`px-4 py-2 ${problem ? "text-danger" : "text-text-2"}`}>{t(problem ?? "device.sfp.ok")}</td>
                    <td className={TD_NUM}>{s.rx_dbm == null ? "–" : dbm(s.rx_dbm)}</td>
                    <td className={TD_NUM}>{s.tx_dbm == null ? "–" : dbm(s.tx_dbm)}</td>
                    <td className={TD_NUM}>{s.temp_c == null ? "–" : temp(s.temp_c)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

function DeviceCharts({ deviceId }: { deviceId: number }) {
  const [usage, poll] = useMemo((): [ChartConfig, ChartConfig] => {
    const source = { kind: "device", id: deviceId } as const;
    return [
      {
        ...newChartConfig(source, [
          { key: "cpu_percent", color: 1 },
          { key: "mem_used_percent", color: 8 },
        ]),
        title: t("device.chart.usage"),
        chart: "line",
      },
      { ...newChartConfig(source, [{ key: "poll_ms", color: 4 }]), title: t("device.chart.poll"), chart: "line" },
    ];
  }, [deviceId]);
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <ChartWidget config={usage} />
      <ChartWidget config={poll} />
    </div>
  );
}

/** Szczegóły urządzenia: informacje, dostępność, wykresy CPU/RAM, porty (z PoE), sieci WiFi i podłączeni klienci. */
export function DevicePage() {
  const id = Number(useParams().deviceId);
  const device = useDevice(id);
  const interfaces = useInterfaces(id);
  const unifi = isOn(useModules().data, "unifi");
  const poe = usePoe(unifi && device.data?.kind === "switch" ? id : null);
  const sensors = useSensors(id);
  // Porty PoE z kontrolera mają nazwy 0/1, 0/2… jak ifName switcha UniFi w SNMP; PoE z SNMP (MikroTik) – nazwa portu
  const poeByName = useMemo(
    () =>
      new Map<string, Pick<PoePort, "power_w">>([
        ...(sensors.data?.poe ?? []).map((p) => [p.port, p] as const),
        ...(poe.data?.ports ?? []).map((p) => [`0/${p.port_idx}`, p] as const),
      ]),
    [poe.data, sensors.data],
  );
  const sensorData = sensors.data;
  const hasSensors = !!sensorData && sensorData.sensors.length + sensorData.poe.length + sensorData.sfp.length > 0;

  if (device.isError) {
    const missing = device.error instanceof ApiError && device.error.status === 404;
    return (
      <>
        <BackLink to="/" label={t("nav.dashboard")} />
        <ErrorNote>{t(missing ? "device.missing" : "device.error")}</ErrorNote>
      </>
    );
  }
  const d = device.data;
  if (!d) return <p role="status" className="py-10 text-center text-sm text-text-2">{t("app.loading")}</p>;

  const Icon = deviceIcon(d.kind);
  const status = d.status in STATUS_STYLE ? d.status : "unknown";
  const ports = interfaces.data ?? [];
  return (
    <>
      <BackLink to="/" label={t("nav.dashboard")} />
      <PageHeader title={d.name}>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded-md px-2 py-0.5 text-xs ${STATUS_STYLE[status]}`}>{t(STATUS_LABEL[status])}</span>
          <DefaultCommunityBadge device={d} />
          <Link
            to="/settings/devices"
            className="inline-flex items-center gap-1.5 rounded-lg border border-border-strong bg-surface px-3 py-1.5 text-sm hover:bg-surface-2"
          >
            <IconPencil size={16} aria-hidden="true" />
            {t("device.settings")}
          </Link>
        </div>
      </PageHeader>
      <p className="-mt-3 mb-4 flex items-center gap-2 text-sm text-text-2">
        <Icon size={18} aria-hidden="true" className="shrink-0" />
        {d.host} · {t(KIND_LABEL[d.kind] ?? "dash.kind.other")}
        {d.model && ` · ${d.model}`}
      </p>

      <div className="flex flex-col gap-3">
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          <InfoCard device={d} />
          <AvailabilityCard kind="devices" id={id} title={t("device.availability")} />
        </div>

        {d.kind === "server" && d.status !== "down" && (
          <Card className="p-4">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-sm font-medium">{t("device.server")}</h2>
              <Link to={`/devices/${id}/server`} className="text-sm text-accent hover:underline">
                {t("srv.all")}
              </Link>
            </div>
            <ServerDetails deviceId={id} />
          </Card>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium text-text-2">{t("device.history")}</h2>
          <RangePicker />
        </div>
        <DeviceCharts deviceId={id} />

        {hasSensors && <SensorsCard data={sensorData} />}
        {ports.length > 0 && <PortsCard deviceId={id} interfaces={ports} poe={poeByName} />}
        <WifiCard deviceId={id} />
        {unifi && <ClientList deviceId={id} title={t("device.clients")} />}
      </div>
    </>
  );
}
