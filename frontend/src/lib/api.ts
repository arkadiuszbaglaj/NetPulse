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

/** Pulpit publiczny (/p/<token>): widgety pytają o swoje zwykłe ścieżki, a klient kieruje je do API publicznego,
 * które wydaje tylko dane widgetów zapisanych w tym pulpicie (backend/netpulse/api/public.py). */
let publicDashboard: { token: string; access: string | null } | null = null;

export function setPublicDashboard(value: { token: string; access: string | null } | null): void {
  publicDashboard = value;
}

function routed(method: string, path: string): string {
  if (!publicDashboard || method !== "GET" || !path.startsWith("/api/") || path.startsWith("/api/public/")) return path;
  return `/api/public/dashboards/${publicDashboard.token}/data?path=${encodeURIComponent(path)}`;
}

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(routed(method, path), {
    method,
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(publicDashboard?.access ? { "X-Dashboard-Access": publicDashboard.access } : {}),
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
export const patch = <T>(path: string, body: unknown) => request<T>("PATCH", path, body);
export const del = (path: string) => request<void>("DELETE", path);

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
  v3_username: string | null;
  v3_auth_protocol: string | null;
  v3_priv_protocol: string | null;
  v3_context: string | null;
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

export type SnmpVersion = "1" | "2c" | "3";
export type DriverName = "auto" | "generic" | "unifi" | "linux" | "mikrotik" | "omada";
export type AuthProtocol = "MD5" | "SHA" | "SHA224" | "SHA256" | "SHA384" | "SHA512";
export type PrivProtocol = "DES" | "AES" | "AES192" | "AES256";

/** Dane połączenia SNMP wysyłane do POST /api/probe i POST /api/devices (bez pól pustych). */
export interface SnmpTargetPayload {
  host: string;
  port: number;
  driver: DriverName;
  snmp_version: SnmpVersion;
  community?: string;
  v3_username?: string;
  v3_auth_protocol?: AuthProtocol;
  v3_auth_key?: string;
  v3_priv_protocol?: PrivProtocol;
  v3_priv_key?: string;
  v3_context?: string;
}

export interface DeviceCreatePayload extends SnmpTargetPayload {
  name: string;
  enabled?: boolean;
}

/** PATCH /api/devices/{id}: tylko zmienione pola; `null` czyści pole. */
export type DeviceUpdatePayload = Partial<{
  name: string;
  enabled: boolean;
  host: string;
  port: number;
  driver: DriverName;
  snmp_version: SnmpVersion;
  community: string | null;
  v3_username: string | null;
  v3_auth_protocol: AuthProtocol | null;
  v3_auth_key: string | null;
  v3_priv_protocol: PrivProtocol | null;
  v3_priv_key: string | null;
  v3_context: string | null;
}>;

export interface ProbeResult {
  driver: string;
  name: string | null;
  vendor: string | null;
  model: string | null;
  firmware: string | null;
  kind: string;
  uptime_s: number | null;
  interfaces: {
    if_index: number;
    name: string;
    label: string;
    alias: string | null;
    role: string;
    hidden: boolean;
    oper_status: string;
    speed_mbps: number | null;
  }[];
  wifi: { ssid: string; radio: string | null; channel: number | null; clients: number | null; hidden: boolean }[];
}

export interface UpdateVersionInfo {
  version: string | null;
  commit: string | null;
  branch?: string | null;
}

export interface UpdateCheck {
  current: UpdateVersionInfo;
  latest: UpdateVersionInfo;
  behind: number;
  ahead: number;
  diverged: boolean;
  update_available: boolean;
  changes: { sha: string; subject: string }[];
  checked_at: string | null;
}

export type UpdatePhaseStatus = "pending" | "running" | "done" | "failed" | "skipped";
export type UpdateJobState = "idle" | "running" | "ok" | "failed" | "rolled_back";

export interface UpdateJob {
  state: UpdateJobState;
  phase: string | null;
  phases: { id: string; status: UpdatePhaseStatus }[];
  started_at: string | null;
  finished_at: string | null;
  from_version: string | null;
  to_version: string | null;
  from_commit: string | null;
  to_commit: string | null;
  error: string | null;
  note: string | null;
  log: string[];
}

export interface UpdatesResponse {
  installed_version: string;
  updater: { configured: boolean; reachable: boolean; message: string | null };
  current: UpdateVersionInfo | null;
  info: UpdateCheck | null;
  job: UpdateJob | null;
}

export type UpdateCheckInterval = 6 | 12 | 24 | 168;
export const UPDATE_CHECK_INTERVALS: UpdateCheckInterval[] = [6, 12, 24, 168];

/** Ustawienie instalacji: automatyczne sprawdzanie wydań (GET/PUT /api/updates/settings). */
export interface UpdateSettings {
  auto_check: boolean;
  interval_h: UpdateCheckInterval;
}
