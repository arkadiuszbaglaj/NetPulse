/** Dane na żywo dla wykresów kołowych (od 0.40.0 tylko one): próbka urządzenia SNMP z WebSocketu
 * `/api/live/device?device=<id>` co ~1,5 s, bez zapisu – porty (prędkość i stan), CPU, RAM i dyski (od 0.41.0). */
import { useEffect, useState } from "react";

export type LiveStatus = "connecting" | "live" | "lost";

export interface LivePort {
  in_bps: number | null;
  out_bps: number | null;
  /** 1 = podłączony, 0 = odłączony */
  up?: number | null;
}

export interface LiveDisk {
  mount: string;
  used_percent: number;
  used_bytes: number;
  free_bytes: number;
  total_bytes: number;
}

export interface LiveSample {
  ports: Map<number, LivePort>;
  cpu_percent: number | null;
  mem_used_percent: number | null;
  /** Tylko serwer Linux przez SNMP */
  disks: LiveDisk[] | null;
}

interface LiveMessage {
  time: string;
  ports: ({ id: number } & LivePort)[];
  cpu_percent?: number | null;
  mem_used_percent?: number | null;
  disks?: LiveDisk[];
}

export function liveUrl(loc: Pick<Location, "protocol" | "host">, path: string): string {
  return `${loc.protocol === "https:" ? "wss" : "ws"}://${loc.host}${path}`;
}

export function parseSample(msg: LiveMessage): LiveSample {
  return {
    ports: new Map(msg.ports.map((p) => [p.id, { in_bps: p.in_bps, out_bps: p.out_bps, up: p.up ?? null }])),
    cpu_percent: msg.cpu_percent ?? null,
    mem_used_percent: msg.mem_used_percent ?? null,
    disks: msg.disks ?? null,
  };
}

/**
 * Próbka urządzenia, dopóki `enabled`. Po utracie połączenia status to „lost” – wykres pokazuje wtedy zwykłe
 * odczyty kolektora. Pierwsza próbka nie ma jeszcze prędkości portów (null).
 */
export function useLiveDevice(deviceId: number | null | undefined, enabled: boolean) {
  const [sample, setSample] = useState<LiveSample | null>(null);
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const path = enabled && deviceId != null ? `/api/live/device?device=${deviceId}` : null;

  useEffect(() => {
    if (!path) return;
    setSample(null);
    setStatus("connecting");
    let closed = false;
    const ws = new WebSocket(liveUrl(window.location, path));
    ws.onmessage = (e) => {
      try {
        setSample(parseSample(JSON.parse(String(e.data)) as LiveMessage));
        setStatus("live");
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

  return { status, sample };
}
