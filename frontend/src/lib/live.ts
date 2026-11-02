/** Dane na żywo dla wykresów kołowych (od 0.40.0 tylko one): prędkość portów urządzenia z WebSocketu
 * `/api/live/ports?device=<id>`, co ~1,5 s, bez zapisu. */
import { useEffect, useState } from "react";

export type LiveStatus = "connecting" | "live" | "lost";

export interface LiveRate {
  in_bps: number | null;
  out_bps: number | null;
}

interface LivePortsMessage {
  time: string;
  ports: ({ id: number } & LiveRate)[];
}

export function liveUrl(loc: Pick<Location, "protocol" | "host">, path: string): string {
  return `${loc.protocol === "https:" ? "wss" : "ws"}://${loc.host}${path}`;
}

/**
 * Prędkość portów urządzenia, dopóki `enabled`. Po utracie połączenia status to „lost” – wykres pokazuje wtedy
 * zwykłe odczyty kolektora. Pierwsza próbka nie ma jeszcze prędkości (null).
 */
export function useLivePorts(deviceId: number | null | undefined, enabled: boolean) {
  const [rates, setRates] = useState<Map<number, LiveRate>>(new Map());
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const path = enabled && deviceId != null ? `/api/live/ports?device=${deviceId}` : null;

  useEffect(() => {
    if (!path) return;
    setRates(new Map());
    setStatus("connecting");
    let closed = false;
    const ws = new WebSocket(liveUrl(window.location, path));
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(String(e.data)) as LivePortsMessage;
        setStatus("live");
        setRates(new Map(msg.ports.map((p) => [p.id, { in_bps: p.in_bps, out_bps: p.out_bps }])));
      } catch {
        /* uszkodzona wiadomość – pomijamy */
      }
    };
    const lost = () => !closed && setStatus("lost");
    ws.onclose = lost;
    ws.onerror = lost;
    return () => {
      closed = true;
      ws.close();
    };
  }, [path]);

  return { status, rates };
}
