/** Klient API NetPulse. Sesja siedzi w ciasteczku HttpOnly, więc wystarczy `same-origin`. */

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** FastAPI zwraca `detail` jako tekst (nasze błędy) albo listę (walidacja Pydantic). */
export function messageFromDetail(detail: unknown, fallback: string): string {
  if (typeof detail === "string" && detail) return detail;
  if (Array.isArray(detail)) {
    const msgs = detail
      .map((d) => (d && typeof d === "object" && "msg" in d ? String((d as { msg: unknown }).msg) : ""))
      .filter(Boolean);
    if (msgs.length) return msgs.join(" ");
  }
  return fallback;
}

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let detail: unknown;
    try {
      detail = (await res.json()).detail;
    } catch {
      /* odpowiedź bez JSON-a */
    }
    throw new ApiError(res.status, messageFromDetail(detail, res.statusText || `HTTP ${res.status}`));
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const get = <T>(path: string) => request<T>("GET", path);
export const post = <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {});

// --- typy odpowiedzi (zgodne z backend/netpulse/api/schemas.py) -------------------

export interface User {
  id: number;
  username: string;
  is_admin: boolean;
  created_at: string;
  last_login_at: string | null;
}

export interface AuthStatus {
  setup_required: boolean;
  authenticated: boolean;
  user: User | null;
  version: string;
}

export interface Device {
  id: number;
  name: string;
  host: string;
  port: number;
  enabled: boolean;
  driver: string;
  detected_driver: string | null;
  snmp_version: string;
  kind: string;
  vendor: string | null;
  model: string | null;
  firmware: string | null;
  sys_name: string | null;
  uptime_s: number | null;
  status: "up" | "down" | "unknown" | string;
  last_polled_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
  created_at: string;
}

export interface DashboardSummary {
  devices: { total: number; up: number; down: number; unknown: number };
  wan: { in_bps: number | null; out_bps: number | null; interfaces: number };
  wifi_clients: number | null;
  last_poll_at: string | null;
  poll_interval_s: number;
}

export interface SeriesPoint {
  time: string;
  values: Record<string, number | null>;
}

export interface Series {
  interval_s: number;
  points: SeriesPoint[];
}
