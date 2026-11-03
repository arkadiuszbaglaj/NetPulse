/** Ruch WAN na żywo (0.45.0): suma portów łączy WAN z kanału na żywo routerów (najwyżej dwa routery). */
import { liveValue, useLiveSample } from "./liveHub";
import { useWanStatus } from "./wan";

export interface LiveWan {
  in_bps: number;
  out_bps: number;
}

export function useLiveWan(want = true): LiveWan | null {
  const links = useWanStatus().data?.links ?? [];
  const routers = [...new Set(links.map((l) => l.device_id))];
  const first = useLiveSample(routers[0], want && routers.length > 0);
  const second = useLiveSample(routers[1], want && routers.length > 1);
  if (!links.length) return null;
  let inBps = 0;
  let outBps = 0;
  let any = false;
  for (const link of links) {
    const state = link.device_id === routers[0] ? first : second;
    const rx = liveValue(state, (s) => s.ports.get(link.interface_id)?.in_bps);
    const tx = liveValue(state, (s) => s.ports.get(link.interface_id)?.out_bps);
    if (rx == null && tx == null) continue;
    any = true;
    inBps += rx ?? 0;
    outBps += tx ?? 0;
  }
  return any ? { in_bps: inBps, out_bps: outBps } : null;
}
