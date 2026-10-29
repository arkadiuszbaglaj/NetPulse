import { IconAccessPoint, IconArrowsMinimize, IconDeviceDesktop, IconMinus, IconNetwork, IconPlus, IconRouter, IconWorld } from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { Link } from "react-router";
import { Card, ErrorNote, PageHeader } from "../components/ui";
import { t, type TextKey } from "../i18n";
import { formatBps } from "../lib/format";
import {
  NODE_H,
  NODE_W,
  fitScale,
  groupByPort,
  isInternetNode,
  layoutTopology,
  loadLevel,
  speedLabel,
  zoomAt,
  type LoadLevel,
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

const LOAD_STROKE: Record<LoadLevel, string> = {
  none: "var(--border-strong)",
  low: "var(--success)",
  mid: "var(--warning)",
  high: "var(--danger)",
};
const LOAD_LABEL: Record<Exclude<LoadLevel, "none">, TextKey> = { low: "topo.load.low", mid: "topo.load.mid", high: "topo.load.high" };

/** Końce kabla: dolna krawędź wyższego węzła i górna niższego (krzywa symetryczna – środek w połowie odcinka). */
function cableEnds(edge: TopologyEdge, places: Record<string, { x: number; y: number }>) {
  const pa = places[edge.a];
  const pb = places[edge.b];
  if (!pa || !pb) return null;
  const [upper, lower, upperPort, lowerPort] = pa.y <= pb.y ? [pa, pb, edge.a_port, edge.b_port] : [pb, pa, edge.b_port, edge.a_port];
  return { x1: upper.x + NODE_W / 2, y1: upper.y + NODE_H, x2: lower.x + NODE_W / 2, y2: lower.y, upperPort, lowerPort };
}

/** Kabel w kolorze obciążenia (grubszy, im bardziej zajęty); numery portów przy obu końcach. */
function Cable({ edge, places }: { edge: TopologyEdge; places: Record<string, { x: number; y: number }> }) {
  const ends = cableEnds(edge, places);
  if (!ends) return null;
  const { x1, y1, x2, y2, upperPort, lowerPort } = ends;
  const mid = (y1 + y2) / 2;
  const level = loadLevel(edge.utilization);
  return (
    <g>
      <path
        d={`M${x1},${y1} C${x1},${mid} ${x2},${mid} ${x2},${y2}`}
        fill="none"
        stroke={LOAD_STROKE[level]}
        strokeWidth={level === "none" ? 2 : 2.5 + 4 * (edge.utilization ?? 0)}
      />
      <PortLabel x={x1} y={y1 + 16} port={upperPort} />
      <PortLabel x={x2} y={y2 - 16} port={lowerPort} />
    </g>
  );
}

/** Opis w połowie kabla: prędkość łącza i bieżący ruch; prowadzi do strony portu. */
function CableInfo({ edge, places }: { edge: TopologyEdge; places: Record<string, { x: number; y: number }> }) {
  const ends = cableEnds(edge, places);
  const speed = speedLabel(edge.speed_mbps);
  if (!ends || (!speed && edge.traffic_bps == null)) return null;
  const text = [speed, edge.traffic_bps != null ? formatBps(edge.traffic_bps) : null].filter(Boolean).join(" · ");
  const level = loadLevel(edge.utilization);
  const title = level === "none" ? text : `${text} – ${t(LOAD_LABEL[level])} (${Math.round((edge.utilization ?? 0) * 100)}%)`;
  const className =
    "absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full border border-border bg-surface px-2 py-0.5 text-[10px] tabular-nums text-text-2";
  const style = { left: (ends.x1 + ends.x2) / 2, top: (ends.y1 + ends.y2) / 2 };
  return edge.interface_id != null && edge.device_id != null ? (
    <Link to={`/devices/${edge.device_id}/ports/${edge.interface_id}`} title={title} className={`${className} hover:border-accent hover:text-accent`} style={style}>
      {text}
    </Link>
  ) : (
    <span title={title} className={className} style={style}>
      {text}
    </span>
  );
}

type View = { scale: number; x: number; y: number };

/** Ramka mapy z przybliżaniem (przyciski, Ctrl + kółko) i przesuwaniem (przeciągnięcie tła). Na starcie i po
 * „Dopasuj” cała mapa mieści się w szerokości – na telefonie bez przewijania w bok. */
function MapViewport({ width, height, children }: { width: number; height: number; children: ReactNode }) {
  const frame = useRef<HTMLDivElement>(null);
  const [frameWidth, setFrameWidth] = useState(0);
  const [view, setView] = useState<View | null>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const fit = fitScale(frameWidth, width);
  const frameHeight = Math.max(240, height * fit);
  const fitted: View = { scale: fit, x: Math.max(0, (frameWidth - width * fit) / 2), y: 0 };
  const current = view ?? fitted;
  const currentRef = useRef(current);
  currentRef.current = current;

  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setFrameWidth(el.clientWidth));
    observer.observe(el);
    setFrameWidth(el.clientWidth);
    // Ctrl + kółko przybliża w miejscu kursora; samo kółko przewija stronę (nasłuch nie-pasywny – bez zoomu strony)
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const base = currentRef.current;
      setView(zoomAt(base, base.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX - r.left, e.clientY - r.top));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      observer.disconnect();
      el.removeEventListener("wheel", onWheel);
    };
  }, []);

  const zoomBy = (factor: number) => setView(zoomAt(current, current.scale * factor, frameWidth / 2, frameHeight / 2));
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("a, button")) return;
    drag.current = { x: e.clientX, y: e.clientY, vx: current.x, vy: current.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent) => {
    const d = drag.current;
    if (d) setView({ scale: current.scale, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y });
  };
  const stop = () => {
    drag.current = null;
  };
  const button = "flex size-8 items-center justify-center rounded-lg border border-border bg-surface text-text-2 hover:text-text";
  return (
    <div
      ref={frame}
      className="relative cursor-grab overflow-hidden rounded-xl border border-border bg-surface-2/40 select-none active:cursor-grabbing"
      // Przybliżona mapa przesuwa się palcem; dopasowana – palec przewija stronę
      style={{ height: frameHeight, touchAction: view && view.scale > fit ? "none" : "pan-y" }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={stop}
      onPointerCancel={stop}
    >
      <div className="absolute top-0 left-0 origin-top-left" style={{ width, height, transform: `translate(${current.x}px, ${current.y}px) scale(${current.scale})` }}>
        {children}
      </div>
      <div role="group" aria-label={t("topo.zoom")} className="absolute top-2 right-2 flex gap-1">
        <button type="button" aria-label={t("topo.zoom.in")} title={t("topo.zoom.in")} className={button} onClick={() => zoomBy(1.25)}>
          <IconPlus size={16} aria-hidden="true" />
        </button>
        <button type="button" aria-label={t("topo.zoom.out")} title={t("topo.zoom.out")} className={button} onClick={() => zoomBy(1 / 1.25)}>
          <IconMinus size={16} aria-hidden="true" />
        </button>
        <button type="button" aria-label={t("topo.zoom.fit")} title={t("topo.zoom.fit")} className={button} onClick={() => setView(null)}>
          <IconArrowsMinimize size={16} aria-hidden="true" />
        </button>
      </div>
    </div>
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
          <MapViewport width={layout.width} height={layout.height}>
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
            {edges.map((e) => (
              <CableInfo key={`${e.a}-${e.b}`} edge={e} places={layout.places} />
            ))}
          </MapViewport>
          <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-2">
            <span>{t("topo.load")}:</span>
            {(["low", "mid", "high"] as const).map((level) => (
              <span key={level} className="inline-flex items-center gap-1.5">
                <span aria-hidden="true" className="inline-block h-1 w-4 rounded-full" style={{ backgroundColor: LOAD_STROKE[level] }} />
                {t(LOAD_LABEL[level])}
              </span>
            ))}
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className="inline-block h-1 w-4 rounded-full" style={{ backgroundColor: LOAD_STROKE.none }} />
              {t("topo.load.none")}
            </span>
          </p>
          <section aria-labelledby="topo-links" className="mt-4">
            <h2 id="topo-links" className="mb-2 text-sm font-medium text-text-2">
              {t("topo.links")}
            </h2>
            <ul className="flex flex-col gap-1 text-sm">
              {edges.map((e) => (
                <li key={`${e.a}-${e.b}`}>
                  {`${name(e.a)}${port(e.a_port)} ↔ ${name(e.b)}${port(e.b_port)}`}
                  {(e.speed_mbps || e.traffic_bps != null) && (
                    <span className="text-text-2">
                      {" – "}
                      {[speedLabel(e.speed_mbps), e.traffic_bps != null ? formatBps(e.traffic_bps) : null].filter(Boolean).join(", ")}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </>
  );
}
