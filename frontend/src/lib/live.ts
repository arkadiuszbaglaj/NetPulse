/** Tryb „Na żywo”: próbki prędkości z WebSocketu (`/api/live/wan`, `/api/live/ports`), trzymane tylko w pamięci. */
import { useEffect, useState } from "react";
import type { Series, SeriesPoint } from "./api";

export type LiveStatus = "connecting" | "live" | "lost";

/** Ile ostatnich próbek zostaje do wykresu (przy ~1,5 s to około 4 minuty). */
export const LIVE_MAX_POINTS = 160;
/** Odstęp próbek podawany wykresowi (dłuższa przerwa jest rysowana jako luka). */
export const LIVE_INTERVAL_S = 3;

interface Rate {
  in_bps: number | null;
  out_bps: number | null;
}

/** Port WAN w próbce: nazwa łącza i prędkość portu (do obciążenia w %). */
export interface LiveWanPort extends Rate {
  id: number;
  device_id: number;
  name: string;
  speed_mbps: number | null;
}

interface LiveMessage extends Rate {
  time: string;
  ports?: LiveWanPort[];
}

interface LivePortsMessage {
  time: string;
  ports: ({ id: number } & Rate)[];
}

export function liveUrl(loc: Pick<Location, "protocol" | "host"> = window.location, path = "/api/live/wan"): string {
  return `${loc.protocol === "https:" ? "wss" : "ws"}://${loc.host}${path}`;
}

/** Dopisuje próbkę i przycina historię do `LIVE_MAX_POINTS`. */
export function appendPoint(points: SeriesPoint[], msg: { time: string } & Rate): SeriesPoint[] {
  const next = [...points, { time: msg.time, values: { in_bps: msg.in_bps, out_bps: msg.out_bps } }];
  return next.length > LIVE_MAX_POINTS ? next.slice(next.length - LIVE_MAX_POINTS) : next;
}

/** Obciążenie portu w % (większy z kierunków względem prędkości łącza); null, gdy nie wiadomo. */
export function loadPercent(rate: Rate, speedMbps: number | null | undefined): number | null {
  const bps = Math.max(rate.in_bps ?? -1, rate.out_bps ?? -1);
  if (!speedMbps || bps < 0) return null;
  return Math.min(100, (bps / (speedMbps * 1_000_000)) * 100);
}

/**
 * Połączenie WebSocket, dopóki podano `path`. Po utracie połączenia status to „lost”
 * (wywołujący wraca do zwykłego odświeżania); `path = null` zamyka gniazdo.
 */
function useLiveSocket<T>(path: string | null, onMessage: (msg: T) => void, reset: () => void): LiveStatus {
  const [status, setStatus] = useState<LiveStatus>("connecting");

  useEffect(() => {
    if (!path) return;
    reset();
    setStatus("connecting");
    let closed = false;
    const ws = new WebSocket(liveUrl(window.location, path));
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(String(e.data)) as T;
        setStatus("live");
        onMessage(msg);
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
    // onMessage i reset korzystają tylko z setterów stanu – nowe połączenie tylko przy zmianie adresu
  }, [path]);

  return status;
}

/** Suma WAN (wykres) i każdy port WAN osobno (ostatnia próbka). */
export function useLiveWan(enabled: boolean) {
  const [points, setPoints] = useState<SeriesPoint[]>([]);
  const [ports, setPorts] = useState<LiveWanPort[]>([]);
  const status = useLiveSocket<LiveMessage>(
    enabled ? "/api/live/wan" : null,
    (msg) => {
      setPoints((p) => appendPoint(p, msg));
      setPorts(msg.ports ?? []);
    },
    () => {
      setPoints([]);
      setPorts([]);
    },
  );

  const series: Series = { interval_s: LIVE_INTERVAL_S, points };
  const last = points.at(-1)?.values;
  return { series, status, ports, current: { in_bps: last?.in_bps ?? null, out_bps: last?.out_bps ?? null } };
}

/** Porty jednego urządzenia: historia próbek każdego portu (do wykresu) i ostatnia próbka (do tabeli). */
export function useLivePorts(deviceId: number | null | undefined, enabled: boolean) {
  const [history, setHistory] = useState<Map<number, SeriesPoint[]>>(new Map());
  const status = useLiveSocket<LivePortsMessage>(
    enabled && deviceId != null ? `/api/live/ports?device=${deviceId}` : null,
    (msg) =>
      setHistory((prev) => {
        const next = new Map(prev);
        for (const p of msg.ports) next.set(p.id, appendPoint(prev.get(p.id) ?? [], { time: msg.time, in_bps: p.in_bps, out_bps: p.out_bps }));
        return next;
      }),
    () => setHistory(new Map()),
  );

  const current = (id: number): Rate | null => {
    const v = history.get(id)?.at(-1)?.values;
    return v ? { in_bps: v.in_bps ?? null, out_bps: v.out_bps ?? null } : null;
  };
  const series = (id: number): Series => ({ interval_s: LIVE_INTERVAL_S, points: history.get(id) ?? [] });
  return { status, current, series, history };
}
