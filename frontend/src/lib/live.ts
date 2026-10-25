/** Tryb „Na żywo”: próbki prędkości WAN z WebSocketu (`/api/live/wan`), trzymane tylko w pamięci. */
import { useEffect, useState } from "react";
import type { Series, SeriesPoint } from "./api";

export type LiveStatus = "connecting" | "live" | "lost";

/** Ile ostatnich próbek zostaje do wykresu (przy ~1,5 s to około 4 minuty). */
export const LIVE_MAX_POINTS = 160;
/** Odstęp próbek podawany wykresowi (dłuższa przerwa jest rysowana jako luka). */
export const LIVE_INTERVAL_S = 3;

interface LiveMessage {
  time: string;
  in_bps: number | null;
  out_bps: number | null;
}

export function liveUrl(loc: Pick<Location, "protocol" | "host"> = window.location): string {
  return `${loc.protocol === "https:" ? "wss" : "ws"}://${loc.host}/api/live/wan`;
}

/** Dopisuje próbkę i przycina historię do `LIVE_MAX_POINTS`. */
export function appendPoint(points: SeriesPoint[], msg: LiveMessage): SeriesPoint[] {
  const next = [...points, { time: msg.time, values: { in_bps: msg.in_bps, out_bps: msg.out_bps } }];
  return next.length > LIVE_MAX_POINTS ? next.slice(next.length - LIVE_MAX_POINTS) : next;
}

/**
 * Połączenie z trybem „Na żywo”, dopóki `enabled`. Po utracie połączenia status to „lost”
 * (wywołujący wraca do zwykłego odświeżania); wyłączenie zamyka gniazdo i czyści próbki.
 */
export function useLiveWan(enabled: boolean) {
  const [points, setPoints] = useState<SeriesPoint[]>([]);
  const [status, setStatus] = useState<LiveStatus>("connecting");

  useEffect(() => {
    if (!enabled) return;
    setPoints([]);
    setStatus("connecting");
    let closed = false;
    const ws = new WebSocket(liveUrl());
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(String(e.data)) as LiveMessage;
        setStatus("live");
        setPoints((p) => appendPoint(p, msg));
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
  }, [enabled]);

  const series: Series = { interval_s: LIVE_INTERVAL_S, points };
  const last = points.at(-1)?.values;
  return { series, status, current: { in_bps: last?.in_bps ?? null, out_bps: last?.out_bps ?? null } };
}
