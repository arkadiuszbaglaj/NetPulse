/**
 * Wspólny kanał na żywo (od 0.45.0): jedno połączenie WebSocket `/api/live/device` na urządzenie dla całej strony,
 * niezależnie od liczby widgetów, które z niego korzystają. Połączenie istnieje, dopóki ktoś ogląda; po zerwaniu
 * wraca samo co kilka sekund. Przełącznik „Na żywo” w pasku górnym (zapamiętany w przeglądarce) wstrzymuje wszystko –
 * widgety pokazują wtedy odczyty kolektora (co 30 s). Na pulpicie publicznym kanału nie ma (wymaga logowania).
 */
import { useQuery } from "@tanstack/react-query";
import { useContext, useEffect, useSyncExternalStore } from "react";
import { get, type Device } from "./api";
import { liveUrl, parseSample, type LiveSample, type LiveStatus } from "./live";
import { PublicModeContext } from "./publicMode";

const STORAGE_KEY = "netpulse.live";
const RETRY_MS = 5_000;
const CLOSE_GRACE_MS = 2_000;

// --- przełącznik ---------------------------------------------------------------------------------

const toggleListeners = new Set<() => void>();

function readEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

let enabled = readEnabled();

export function setLiveEnabled(on: boolean): void {
  enabled = on;
  try {
    localStorage.setItem(STORAGE_KEY, on ? "on" : "off");
  } catch {
    /* bez zapamiętywania */
  }
  toggleListeners.forEach((l) => l());
}

/** Czy dane na żywo są włączone (przełącznik w pasku górnym; na pulpicie publicznym zawsze nie). */
export function useLiveEnabled(): boolean {
  const isPublic = useContext(PublicModeContext);
  const on = useSyncExternalStore(
    (l) => {
      toggleListeners.add(l);
      return () => toggleListeners.delete(l);
    },
    () => enabled,
  );
  return on && !isPublic;
}

// --- połączenia ------------------------------------------------------------------------------------

export interface LiveState {
  status: LiveStatus;
  sample: LiveSample | null;
}

interface Entry {
  refs: number;
  state: LiveState;
  ws: WebSocket | null;
  listeners: Set<() => void>;
  retry: ReturnType<typeof setTimeout> | null;
  closing: ReturnType<typeof setTimeout> | null;
}

const IDLE: LiveState = { status: "connecting", sample: null };
const entries = new Map<number, Entry>();

function entry(deviceId: number): Entry {
  let e = entries.get(deviceId);
  if (!e) {
    e = { refs: 0, state: IDLE, ws: null, listeners: new Set(), retry: null, closing: null };
    entries.set(deviceId, e);
  }
  return e;
}

function emit(e: Entry, state: LiveState) {
  e.state = state;
  e.listeners.forEach((l) => l());
}

function connect(deviceId: number, e: Entry) {
  if (e.ws || typeof WebSocket === "undefined") return;
  const ws = new WebSocket(liveUrl(window.location, `/api/live/device?device=${deviceId}`));
  e.ws = ws;
  ws.onmessage = (msg) => {
    try {
      emit(e, { status: "live", sample: parseSample(JSON.parse(String(msg.data))) });
    } catch {
      /* uszkodzona wiadomość – pomijamy */
    }
  };
  const lost = () => {
    if (e.ws !== ws) return;
    e.ws = null;
    emit(e, { status: "lost", sample: null });
    if (e.refs > 0 && !e.retry) {
      e.retry = setTimeout(() => {
        e.retry = null;
        if (e.refs > 0) connect(deviceId, e);
      }, RETRY_MS);
    }
  };
  ws.onclose = lost;
  ws.onerror = lost;
}

function release(deviceId: number, e: Entry) {
  e.refs -= 1;
  if (e.refs > 0) return;
  // Chwila zwłoki: przy przełączaniu stron i przerysowaniu widgetów połączenie nie jest zamykane i otwierane od nowa
  e.closing = setTimeout(() => {
    e.closing = null;
    if (e.refs > 0) return;
    if (e.retry) clearTimeout(e.retry);
    e.retry = null;
    const ws = e.ws;
    e.ws = null;
    ws?.close();
    e.state = IDLE;
    entries.delete(deviceId);
  }, CLOSE_GRACE_MS);
}

/**
 * Najnowsza próbka urządzenia z kanału na żywo albo `null` (wyłączone, pulpit publiczny, brak połączenia,
 * urządzenie bez SNMP). Wiele widgetów tego samego urządzenia dzieli jedno połączenie.
 */
export function useLiveSample(deviceId: number | null | undefined, want = true): LiveState | null {
  const on = useLiveEnabled();
  const id = on && want && deviceId != null ? deviceId : null;
  useEffect(() => {
    if (id == null) return;
    const e = entry(id);
    if (e.closing) clearTimeout(e.closing);
    e.closing = null;
    e.refs += 1;
    connect(id, e);
    return () => release(id, e);
  }, [id]);
  const state = useSyncExternalStore(
    (l) => {
      if (id == null) return () => {};
      const e = entry(id);
      e.listeners.add(l);
      return () => e.listeners.delete(l);
    },
    () => (id == null ? null : (entries.get(id)?.state ?? IDLE)),
  );
  return state;
}

/** Wartość z próbki tylko wtedy, gdy jest świeża („live”) i ją zawiera. */
export function liveValue(state: LiveState | null, pick: (s: LiveSample) => number | null | undefined): number | null {
  if (!state || state.status !== "live" || !state.sample) return null;
  const v = pick(state.sample);
  return v == null || !Number.isFinite(v) ? null : v;
}

/** Urządzenia bez SNMP (agent wysyła co 30 s, Proxmox liczy co ~10 s) – kanał na żywo nic dla nich nie ma. */
const NON_SNMP = new Set(["agent", "proxmox"]);

/** Jak `useLiveSample`, ale tylko dla działających urządzeń odpytywanych przez SNMP (lista urządzeń z pamięci podręcznej). */
export function useLiveDeviceSample(deviceId: number | null | undefined, want = true): LiveState | null {
  const on = useLiveEnabled();
  const devices = useQuery({ queryKey: ["devices"], queryFn: () => get<Device[]>("/api/devices"), enabled: on && want && deviceId != null });
  const device = devices.data?.find((d) => d.id === deviceId);
  // Tylko urządzenia, które odpowiadają – do wyłączonego nie ma sensu pytać co 1,5 s (wróci po następnym cyklu kolektora)
  return useLiveSample(deviceId, want && !!device && device.enabled && device.status === "up" && !NON_SNMP.has(device.driver));
}

/** Testy: zamyka wszystkie połączenia i zapomina stan (moduł żyje między testami). */
export function resetLiveHub(): void {
  for (const e of entries.values()) {
    if (e.retry) clearTimeout(e.retry);
    if (e.closing) clearTimeout(e.closing);
    e.ws?.close();
  }
  entries.clear();
  enabled = readEnabled();
}
