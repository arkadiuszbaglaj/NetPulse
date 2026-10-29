/** Mapa sieci: dane z `/api/topology` i układ drzewa (czyste funkcje, bez Reacta). */
import { useQuery } from "@tanstack/react-query";
import { get } from "./api";
import { useRefresh } from "./refresh";

export interface TopologyNode {
  id: string;
  kind: "device" | "external";
  device_id: number | null;
  name: string;
  device_kind: string | null;
  model: string | null;
  status: string | null;
}

export interface TopologyEdge {
  a: string;
  a_port: number | null;
  b: string;
  b_port: number | null;
  /** Obciążenie kabla (0.35.0): port SNMP jednej ze stron, jego prędkość, ruch (większy kierunek) i wykorzystanie 0–1 */
  interface_id?: number | null;
  device_id?: number | null;
  speed_mbps?: number | null;
  traffic_bps?: number | null;
  utilization?: number | null;
}

export type LoadLevel = "none" | "low" | "mid" | "high";

/** Poziom obciążenia kabla: do 50% niski, do 80% średni, wyżej wysoki; bez danych – „none”. */
export function loadLevel(utilization: number | null | undefined): LoadLevel {
  if (utilization == null) return "none";
  return utilization >= 0.8 ? "high" : utilization >= 0.5 ? "mid" : "low";
}

/** Prędkość łącza krótko: 1G, 2.5G, 100M. */
export function speedLabel(mbps: number | null | undefined): string | null {
  if (!mbps) return null;
  return mbps >= 1000 ? `${+(mbps / 1000).toFixed(1)}G` : `${mbps}M`;
}

export const MIN_SCALE = 0.3;
export const MAX_SCALE = 2;
export const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

/** Skala „Dopasuj”: cała mapa w szerokości ramki, bez powiększania ponad 100%. */
export function fitScale(frameWidth: number, contentWidth: number): number {
  return contentWidth > 0 && frameWidth > 0 ? clampScale(Math.min(1, frameWidth / contentWidth)) : 1;
}

/** Zmiana skali względem punktu (np. środka ramki): ten punkt mapy zostaje w tym samym miejscu ekranu. */
export function zoomAt(view: { scale: number; x: number; y: number }, scale: number, px: number, py: number) {
  const next = clampScale(scale);
  const k = next / view.scale;
  return { scale: next, x: px - (px - view.x) * k, y: py - (py - view.y) * k };
}

export interface Topology {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
}

export function useTopology() {
  const { refetchInterval } = useRefresh();
  return useQuery({
    queryKey: ["topology"],
    queryFn: () => get<Topology>("/api/topology"),
    refetchInterval,
  });
}

/** Czy węzeł zewnętrzny to „Internet”: łączy się wyłącznie z bramą (router), więc jest za jej portem WAN. */
export function isInternetNode(node: TopologyNode, nodes: TopologyNode[], edges: TopologyEdge[]): boolean {
  if (node.kind !== "external") return false;
  const links = edges.filter((e) => e.a === node.id || e.b === node.id);
  if (links.length === 0) return false;
  return links.every((e) => {
    const other = nodes.find((n) => n.id === (e.a === node.id ? e.b : e.a));
    return other?.kind === "device" && other.device_kind === "gateway";
  });
}

export interface PortGroup<T> {
  port: number | null;
  items: T[];
}

/** Klienci po kablu pogrupowani według portu (np. komputer z maszynami wirtualnymi na jednym kablu), porty rosnąco. */
export function groupByPort<T extends { uplink_port: number | null }>(clients: T[]): PortGroup<T>[] {
  const groups = new Map<number | null, T[]>();
  for (const c of clients) groups.set(c.uplink_port, [...(groups.get(c.uplink_port) ?? []), c]);
  return [...groups.entries()]
    .map(([port, items]) => ({ port, items }))
    .sort((a, b) => (a.port ?? Infinity) - (b.port ?? Infinity));
}

export const NODE_W = 200;
export const NODE_H = 132;
const GAP_X = 32;
// Między warstwami mieszczą się trzy opisy: port u góry, prędkość i ruch w połowie, port na dole
const GAP_Y = 100;

export interface Placement {
  x: number;
  y: number;
  level: number;
}

export interface TopologyLayout {
  places: Record<string, Placement>;
  width: number;
  height: number;
}

/** Korzeń drzewa: brama (router), a gdy jej nie ma, pierwsze urządzenie. */
export function pickRoot(nodes: TopologyNode[]): TopologyNode | undefined {
  return nodes.find((n) => n.kind === "device" && n.device_kind === "gateway") ?? nodes.find((n) => n.kind === "device") ?? nodes[0];
}

/**
 * Układ warstwowy: brama w środku, sąsiedzi z zewnątrz (np. modem na WAN) nad nią, dalsze urządzenia w dół
 * według odległości od bramy. W warstwie kolejność wynika ze średniego położenia sąsiadów z warstwy wyżej,
 * żeby kable się nie krzyżowały. Urządzenia niepołączone z bramą trafiają do ostatniej warstwy.
 */
export function layoutTopology(nodes: TopologyNode[], edges: TopologyEdge[]): TopologyLayout {
  const root = pickRoot(nodes);
  if (!root) return { places: {}, width: 0, height: 0 };

  const neighbors = new Map<string, string[]>();
  for (const n of nodes) neighbors.set(n.id, []);
  for (const e of edges) {
    neighbors.get(e.a)?.push(e.b);
    neighbors.get(e.b)?.push(e.a);
  }

  // Głębokość = liczba kabli od korzenia (BFS)
  const depth = new Map<string, number>([[root.id, 0]]);
  const queue = [root.id];
  for (let i = 0; i < queue.length; i++) {
    for (const next of neighbors.get(queue[i]) ?? []) {
      if (!depth.has(next)) {
        depth.set(next, depth.get(queue[i])! + 1);
        queue.push(next);
      }
    }
  }
  // Sąsiedzi zewnętrzni samej bramy idą nad nią
  const level = new Map<string, number>();
  for (const n of nodes) {
    const d = depth.get(n.id);
    if (d === undefined) continue;
    const onlyRoot = (neighbors.get(n.id) ?? []).every((x) => x === root.id);
    level.set(n.id, n.kind === "external" && d === 1 && onlyRoot ? -1 : d);
  }
  const maxLevel = Math.max(0, ...level.values());
  for (const n of nodes) if (!level.has(n.id)) level.set(n.id, maxLevel + 1); // niepołączone
  const minLevel = Math.min(0, ...level.values());

  const byLevel = new Map<number, TopologyNode[]>();
  for (const n of [...nodes].sort((a, b) => a.name.localeCompare(b.name, "pl"))) {
    const l = level.get(n.id)! - minLevel;
    byLevel.set(l, [...(byLevel.get(l) ?? []), n]);
  }
  const levels = [...byLevel.keys()].sort((a, b) => a - b);
  const widest = Math.max(...levels.map((l) => byLevel.get(l)!.length));
  const width = widest * NODE_W + (widest + 1) * GAP_X;

  const places: Record<string, Placement> = {};
  for (const l of levels) {
    let row = byLevel.get(l)!;
    if (l > 0) {
      const center = (id: string) => {
        const xs = (neighbors.get(id) ?? []).filter((x) => places[x] && places[x].level < l).map((x) => places[x].x);
        return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : width / 2;
      };
      row = [...row].sort((a, b) => center(a.id) - center(b.id));
    }
    const rowWidth = row.length * NODE_W + (row.length - 1) * GAP_X;
    const start = (width - rowWidth) / 2;
    row.forEach((n, i) => {
      places[n.id] = { x: start + i * (NODE_W + GAP_X), y: GAP_Y / 2 + l * (NODE_H + GAP_Y), level: l };
    });
  }
  const height = levels.length * NODE_H + (levels.length - 1) * GAP_Y + GAP_Y;
  return { places, width, height };
}
