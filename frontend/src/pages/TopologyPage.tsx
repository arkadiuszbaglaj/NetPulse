import { IconAccessPoint, IconDeviceDesktop, IconNetwork, IconRouter, IconWorld } from "@tabler/icons-react";
import { useMemo } from "react";
import { Link } from "react-router";
import { Card, ErrorNote, PageHeader } from "../components/ui";
import { t, type TextKey } from "../i18n";
import {
  NODE_H,
  NODE_W,
  groupByPort,
  isInternetNode,
  layoutTopology,
  useTopology,
  type TopologyEdge,
  type TopologyNode,
} from "../lib/topology";
import { useClients, type NetworkClient } from "../lib/unifi";

const KIND_ICON = { gateway: IconRouter, switch: IconNetwork, ap: IconAccessPoint } as const;
const KIND_LABEL: Record<string, TextKey> = {
  gateway: "dash.kind.gateway",
  switch: "dash.kind.switch",
  ap: "dash.kind.ap",
  other: "dash.kind.other",
};
const STATUS_DOT: Record<string, string> = { up: "bg-success", down: "bg-danger", unknown: "bg-muted" };
const STATUS_LABEL: Record<string, TextKey> = {
  up: "dash.status.up",
  down: "dash.status.down",
  unknown: "dash.status.unknown",
};
const MAX_LISTED = 3;

function clientName(c: NetworkClient): string {
  return c.name ?? c.ip ?? c.mac;
}

/** „2–4 urządzenia”, ale „5 urządzeń” – polska odmiana. */
function devicesLabel(n: number): string {
  const few = n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20);
  return t(few ? "topo.devices.few" : "topo.devices.many", { n });
}

function NodeCard({ node, clients, internet }: { node: TopologyNode; clients: NetworkClient[]; internet: boolean }) {
  if (node.kind === "external") {
    return (
      <Card className="flex h-full flex-col items-center justify-center gap-1 border-dashed p-3 text-center">
        <div className="flex items-center justify-center gap-2 text-sm font-medium">
          <IconWorld size={18} aria-hidden="true" className="shrink-0 text-text-2" />
          {internet ? t("topo.internet") : t("topo.external")}
        </div>
        {!internet && <p className="w-full truncate font-mono text-xs text-text-2">{node.name}</p>}
      </Card>
    );
  }
  const Icon = KIND_ICON[node.device_kind as keyof typeof KIND_ICON] ?? IconDeviceDesktop;
  const status = node.status && node.status in STATUS_DOT ? node.status : "unknown";
  const wired = groupByPort(clients.filter((c) => c.is_wired));
  const wifi = clients.filter((c) => !c.is_wired);
  return (
    <Card className="flex h-full flex-col items-center gap-1.5 overflow-hidden p-3 text-center">
      <div className="flex w-full items-center justify-center gap-2">
        <Icon size={20} aria-hidden="true" className="shrink-0 text-text-2" />
        <h3 className="min-w-0 truncate text-sm font-medium">
          {node.device_id != null ? (
            <Link to={`/devices/${node.device_id}`} className="hover:text-accent hover:underline">
              {node.name}
            </Link>
          ) : (
            node.name
          )}
        </h3>
        <span
          role="img"
          aria-label={t(STATUS_LABEL[status])}
          title={t(STATUS_LABEL[status])}
          className={`size-2.5 shrink-0 rounded-full ${STATUS_DOT[status]}`}
        />
      </div>
      <p className="w-full truncate text-xs text-text-2">
        {[t(KIND_LABEL[node.device_kind ?? "other"] ?? "dash.kind.other"), node.model].filter(Boolean).join(" · ")}
      </p>
      {wifi.length > 0 && <p className="w-full truncate text-xs">{t("topo.wifi", { n: wifi.length })}</p>}
      {wired.slice(0, MAX_LISTED).map((g) => (
        <p key={g.port ?? "none"} className="w-full truncate text-xs text-text-2" title={g.items.map(clientName).join(", ")}>
          {g.port != null ? `${t("clients.port", { n: g.port })}: ` : ""}
          {g.items.length > 1 ? devicesLabel(g.items.length) : clientName(g.items[0])}
        </p>
      ))}
      {wired.length > MAX_LISTED && <p className="w-full text-xs text-text-2">{t("topo.more", { n: wired.length - MAX_LISTED })}</p>}
    </Card>
  );
}

function PortLabel({ x, y, port }: { x: number; y: number; port: number | null }) {
  if (port == null) return null;
  return (
    <g>
      <rect x={x - 26} y={y - 9} width={52} height={18} rx={9} className="fill-surface stroke-border" />
      <text x={x} y={y + 4} textAnchor="middle" className="fill-text-2 text-[10px]">
        {t("clients.port", { n: port })}
      </text>
    </g>
  );
}

/** Kabel między dolną krawędzią wyższego węzła a górną niższego; numery portów przy obu końcach. */
function Cable({ edge, places }: { edge: TopologyEdge; places: Record<string, { x: number; y: number }> }) {
  const pa = places[edge.a];
  const pb = places[edge.b];
  if (!pa || !pb) return null;
  const [upper, lower, upperPort, lowerPort] = pa.y <= pb.y ? [pa, pb, edge.a_port, edge.b_port] : [pb, pa, edge.b_port, edge.a_port];
  const x1 = upper.x + NODE_W / 2;
  const y1 = upper.y + NODE_H;
  const x2 = lower.x + NODE_W / 2;
  const y2 = lower.y;
  const mid = (y1 + y2) / 2;
  return (
    <g>
      <path d={`M${x1},${y1} C${x1},${mid} ${x2},${mid} ${x2},${y2}`} fill="none" className="stroke-border-strong" strokeWidth={2} />
      <PortLabel x={x1} y={y1 + 16} port={upperPort} />
      <PortLabel x={x2} y={y2 - 16} port={lowerPort} />
    </g>
  );
}

/** Mapa sieci z tablic LLDP kontrolera UniFi: brama na górze, pod nią switche, AP i klienci. */
export function TopologyPage() {
  const topo = useTopology();
  const clients = useClients();
  const nodes = useMemo(() => topo.data?.nodes ?? [], [topo.data]);
  const edges = useMemo(() => topo.data?.edges ?? [], [topo.data]);
  const layout = useMemo(() => layoutTopology(nodes, edges), [nodes, edges]);
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const clientsOf = (n: TopologyNode) => (clients.data ?? []).filter((c) => n.device_id != null && c.uplink_device_id === n.device_id);
  const name = (id: string) => byId.get(id)?.name ?? id;
  const port = (p: number | null) => (p != null ? ` (${t("clients.port", { n: p })})` : "");

  return (
    <>
      <PageHeader title={t("topo.title")} />
      {topo.isError && <ErrorNote>{t("topo.error")}</ErrorNote>}
      {topo.data && nodes.length === 0 && (
        <Card className="p-6">
          <h2 className="text-base font-medium">{t("topo.empty.title")}</h2>
          <p className="mt-1 text-sm text-text-2">{t("topo.empty.body")}</p>
        </Card>
      )}
      {nodes.length > 0 && (
        <>
          <div className="overflow-x-auto rounded-xl border border-border bg-surface-2/40">
            <div className="relative mx-auto" style={{ width: layout.width, height: layout.height }}>
              <svg aria-hidden="true" width={layout.width} height={layout.height} className="absolute inset-0">
                {edges.map((e) => (
                  <Cable key={`${e.a}-${e.b}`} edge={e} places={layout.places} />
                ))}
              </svg>
              {nodes.map((n) => {
                const p = layout.places[n.id];
                return (
                  p && (
                    <div key={n.id} className="absolute" style={{ left: p.x, top: p.y, width: NODE_W, height: NODE_H }}>
                      <NodeCard node={n} clients={clientsOf(n)} internet={isInternetNode(n, nodes, edges)} />
                    </div>
                  )
                );
              })}
            </div>
          </div>
          <section aria-labelledby="topo-links" className="mt-4">
            <h2 id="topo-links" className="mb-2 text-sm font-medium text-text-2">
              {t("topo.links")}
            </h2>
            <ul className="flex flex-col gap-1 text-sm">
              {edges.map((e) => (
                <li key={`${e.a}-${e.b}`}>
                  {`${name(e.a)}${port(e.a_port)} ↔ ${name(e.b)}${port(e.b_port)}`}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </>
  );
}
