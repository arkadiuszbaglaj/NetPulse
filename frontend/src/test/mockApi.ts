import { vi } from "vitest";
import type {
  AuthStatus,
  DashboardSummary,
  Device,
  ProbeResult,
  Series,
  UpdateCheck,
  UpdateJob,
  UpdateSettings,
  UpdatesResponse,
  User,
} from "../lib/api";
import type { Alert, AlertRule } from "../lib/alerts";
import type { DashboardLayout } from "../lib/layout";
import type { Topology } from "../lib/topology";
import type { Controller, NetworkClient, PoeInfo } from "../lib/unifi";

export const USER: User = {
  id: 1,
  username: "admin",
  is_admin: true,
  created_at: "2026-10-24T20:00:00Z",
  last_login_at: "2026-10-24T20:05:00Z",
};

export const DEVICE: Device = {
  id: 1,
  name: "UCG Ultra",
  host: "192.168.1.1",
  port: 161,
  enabled: true,
  driver: "auto",
  detected_driver: "unifi",
  snmp_version: "2c",
  v3_username: null,
  v3_auth_protocol: null,
  v3_priv_protocol: null,
  v3_context: null,
  kind: "gateway",
  vendor: "Ubiquiti",
  model: "UCG-Ultra",
  firmware: null,
  sys_name: "UCG",
  uptime_s: 1000,
  status: "up",
  last_polled_at: new Date().toISOString(),
  last_ok_at: new Date().toISOString(),
  last_error: null,
  created_at: "2026-10-01T00:00:00Z",
};

export const SUMMARY: DashboardSummary = {
  devices: { total: 4, up: 3, down: 1, unknown: 0 },
  wan: { in_bps: 42_300_000, out_bps: 6_500_000, interfaces: 1 },
  wifi_clients: 17,
  last_poll_at: new Date().toISOString(),
  poll_interval_s: 30,
};

export const TRAFFIC: Series = {
  interval_s: 30,
  points: [
    { time: "2026-10-24T20:00:00Z", values: { in_bps: 1e6, out_bps: 2e5 } },
    { time: "2026-10-24T20:00:30Z", values: { in_bps: 2e6, out_bps: 3e5 } },
  ],
};

export const PROBE: ProbeResult = {
  driver: "unifi",
  name: "USW-Switch",
  vendor: "Ubiquiti",
  model: "UniFi Switch",
  firmware: null,
  kind: "switch",
  uptime_s: 3_950_000,
  interfaces: [
    { if_index: 1, name: "0/1", label: "Port 1", alias: "AP U6+", role: "port", hidden: false, oper_status: "up", speed_mbps: 1000 },
    { if_index: 2, name: "0/2", label: "Port 2", alias: null, role: "port", hidden: false, oper_status: "down", speed_mbps: null },
    { if_index: 99, name: "lo", label: "lo", alias: null, role: "virtual", hidden: true, oper_status: "up", speed_mbps: null },
  ],
  wifi: [],
};

export const IDLE_JOB: UpdateJob = {
  state: "idle",
  phase: null,
  phases: [],
  started_at: null,
  finished_at: null,
  from_version: null,
  to_version: null,
  from_commit: null,
  to_commit: null,
  error: null,
  note: null,
  log: [],
};

export const UPDATES: UpdatesResponse = {
  installed_version: "0.2.0",
  updater: { configured: true, reachable: true, message: null },
  current: { version: "0.2.0", commit: "abc1234", branch: "main" },
  info: null,
  job: IDLE_JOB,
};

export const UP_TO_DATE: UpdateCheck = {
  current: { version: "0.2.0", commit: "abc1234" },
  latest: { version: "0.2.0", commit: "abc1234" },
  behind: 0,
  ahead: 0,
  diverged: false,
  update_available: false,
  changes: [],
  checked_at: new Date().toISOString(),
};

export const UPDATE_AVAILABLE: UpdateCheck = {
  current: { version: "0.2.0", commit: "abc1234" },
  latest: { version: "0.3.0", commit: "def5678" },
  behind: 2,
  ahead: 0,
  diverged: false,
  update_available: true,
  changes: [
    { sha: "def5678", subject: "Etap B: druga zmiana" },
    { sha: "aaa1111", subject: "Etap A: pierwsza zmiana" },
  ],
  checked_at: new Date().toISOString(),
};

export const RUNNING_JOB: UpdateJob = {
  ...IDLE_JOB,
  state: "running",
  phase: "build",
  phases: [
    { id: "prepare", status: "done" },
    { id: "backup", status: "done" },
    { id: "fetch", status: "done" },
    { id: "build", status: "running" },
    { id: "start", status: "pending" },
    { id: "verify", status: "pending" },
  ],
  started_at: "2026-10-24T20:00:00Z",
  from_version: "0.2.0",
  to_version: "0.3.0",
  from_commit: "abc1234",
  to_commit: "def5678",
  log: ["== prepare", "Wolne miejsce: 20000 MB", "== build", "Step 1/8 : FROM node"],
};

export const CONTROLLER: Controller = {
  id: 1,
  name: "UniFi",
  host: "192.168.1.1",
  port: 443,
  site: "default",
  verify_tls: false,
  enabled: true,
  app_version: "10.6.109",
  status: "up",
  last_polled_at: new Date().toISOString(),
  last_ok_at: new Date().toISOString(),
  last_error: null,
  created_at: "2026-10-25T00:00:00Z",
};

export const CLIENTS: NetworkClient[] = [
  {
    mac: "02:00:00:00:00:01", name: "Telefon Ani", ip: "192.168.1.50", is_wired: false, is_guest: false, essid: "Dom", radio: "na",
    signal_dbm: -52, tx_rate_kbps: 866000, rx_rate_kbps: 720000, uplink_device_id: 3, uplink_name: "U6+", uplink_port: null,
    connected_s: 7200, updated_at: "2026-10-25T10:00:00Z",
  },
  {
    mac: "02:00:00:00:00:02", name: "Telewizor", ip: "192.168.1.60", is_wired: true, is_guest: false, essid: null, radio: null,
    signal_dbm: null, tx_rate_kbps: null, rx_rate_kbps: null, uplink_device_id: 2, uplink_name: "USW", uplink_port: 7,
    connected_s: 90000, updated_at: "2026-10-25T10:00:00Z",
  },
];

export const POE: PoeInfo = {
  budget: { used_w: 3.9, max_w: 52 },
  ports: [
    { port_idx: 1, label: "AP U6+", power_w: 3.9, voltage_v: 53.3, current_ma: 73, mode: "auto", poe_class: "Class 3", delivering: true },
    { port_idx: 2, label: null, power_w: 0, voltage_v: null, current_ma: null, mode: "off", poe_class: null, delivering: false },
  ],
};

export interface Call {
  method: string;
  path: string;
  body: unknown;
}

interface MockState {
  setupRequired: boolean;
  authenticated: boolean;
  devices: Device[];
  summary: DashboardSummary;
  traffic: Series;
  wifi: Series;
  probe: ProbeResult;
  /** Czy zalogowany użytkownik jest administratorem */
  admin: boolean;
  updates: UpdatesResponse;
  /** Odpowiedź na POST /api/updates/check (domyślnie bez zmian) */
  afterCheck?: UpdatesResponse;
  /** Odpowiedź na POST /api/updates/apply (domyślnie zadanie w toku) */
  afterApply?: UpdatesResponse;
  /** Ustawienia automatycznego sprawdzania aktualizacji */
  updateSettings: UpdateSettings;
  /** Zapisany układ pulpitu (null = domyślny) */
  layout: DashboardLayout | null;
  controllers: Controller[];
  alerts: Alert[];
  rules: AlertRule[];
  clients: NetworkClient[];
  poe: PoeInfo;
  topology: Topology;
  /** Nadpisanie odpowiedzi: "POST /api/auth/login" → { status, body } */
  overrides: Record<string, { status: number; body?: unknown }>;
}

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
  });

/** Podmienia fetch na atrapę API. Zwraca stan (do zmiany w teście) i listę wykonanych wywołań. */
export function mockApi(initial: Partial<MockState> = {}) {
  const state: MockState = { setupRequired: false, authenticated: true, devices: [DEVICE],
    summary: SUMMARY,
    traffic: TRAFFIC,
    wifi: { interval_s: 30, points: [{ time: "2026-10-24T20:00:00Z", values: { clients: 5 } }] },
    probe: PROBE,
    admin: true,
    layout: null,
    controllers: [],
    alerts: [],
    rules: [],
    clients: [],
    poe: { budget: null, ports: [] },
    topology: { nodes: [], edges: [] },
    updateSettings: { auto_check: true, interval_h: 24 },
    updates: UPDATES,
    overrides: {},
    ...initial,
  };
  // Kopie urządzeń: PATCH zmienia obiekty, a testy nie mogą sobie nawzajem psuć wspólnego DEVICE
  state.devices = state.devices.map((d) => ({ ...d }));
  const calls: Call[] = [];

  const status = (): AuthStatus => ({
    setup_required: state.setupRequired,
    authenticated: state.authenticated && !state.setupRequired,
    user: state.authenticated && !state.setupRequired ? { ...USER, is_admin: state.admin } : null,
    version: "0.2.0",
  });

  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    // Klucz bez parametrów zapytania; pełna ścieżka zostaje w `calls`
    const key = `${method} ${path.split("?")[0]}`;

    const override = state.overrides[key];
    if (override) return json(override.status, override.body);

    // Urządzenia: dodawanie, test, edycja i usuwanie (sekrety z żądań nie wracają w odpowiedziach)
    if (state.authenticated) {
      if (key === "GET /api/alerts") {
        const wanted = new URL(path, "http://x").searchParams.get("state") ?? "firing";
        return json(200, state.alerts.filter((a) => a.state === wanted));
      }
      if (key === "GET /api/alerts/summary") {
        const firing = state.alerts.filter((a) => a.state === "firing");
        const count = (s: string) => firing.filter((a) => a.severity === s).length;
        return json(200, {
          firing: firing.length,
          unacked: firing.filter((a) => !a.acked_at).length,
          critical: count("critical"),
          warning: count("warning"),
          info: count("info"),
        });
      }
      const ack = /^POST \/api\/alerts\/(\d+)\/ack$/.exec(key);
      if (ack) {
        const alert = state.alerts.find((a) => a.id === Number(ack[1]));
        if (!alert) return json(404, { detail: "Nie ma takiego alertu" });
        alert.acked_at = new Date().toISOString();
        alert.acked_by = "admin";
        return json(200, alert);
      }
      if (key === "GET /api/alert-rules") return json(200, state.rules);
      if (key === "GET /api/alert-rules/metrics") {
        return json(200, [
          { metric: "cpu_percent", label: "CPU", unit: "%", per_device: true },
          { metric: "wan_in_bps", label: "Pobieranie WAN", unit: "b/s", per_device: false },
        ]);
      }
      if (key === "POST /api/alert-rules") {
        const rule = { ...(body as Omit<AlertRule, "id" | "created_at">), id: state.rules.length + 1, created_at: "2026-10-25T10:00:00Z" } as AlertRule;
        state.rules.push(rule);
        return json(201, rule);
      }
      const ruleMatch = /^(PUT|DELETE) \/api\/alert-rules\/(\d+)$/.exec(key);
      if (ruleMatch) {
        const rule = state.rules.find((r) => r.id === Number(ruleMatch[2]));
        if (!rule) return json(404, { detail: "Nie ma takiej reguły" });
        if (ruleMatch[1] === "DELETE") {
          state.rules = state.rules.filter((r) => r !== rule);
          return json(204);
        }
        Object.assign(rule, body);
        return json(200, rule);
      }
      if (key === "GET /api/controllers") return json(200, state.controllers);
      if (key === "POST /api/controllers/probe") {
        const b = body as { api_key: string };
        return b.api_key === "zly-klucz-api" ? json(422, { detail: "Kontroler odrzucił klucz API" }) : json(200, { app_version: "10.6.109", devices: 3, clients: 9 });
      }
      if (key === "POST /api/controllers") {
        const b = body as Partial<Controller> & { host: string; name: string };
        const created: Controller = { ...CONTROLLER, id: state.controllers.length + 1, name: b.name, host: b.host, port: b.port ?? 443, site: b.site ?? "default" };
        state.controllers.push(created);
        return json(201, created);
      }
      const ctrl = /^(PATCH|DELETE) \/api\/controllers\/(\d+)$/.exec(key);
      if (ctrl) {
        const c = state.controllers.find((x) => x.id === Number(ctrl[2]));
        if (!c) return json(404, { detail: "Nie ma takiego kontrolera" });
        if (ctrl[1] === "DELETE") {
          state.controllers = state.controllers.filter((x) => x !== c);
          return json(204);
        }
        const { api_key: _k, ...fields } = body as Record<string, unknown>;
        Object.assign(c, fields);
        return json(200, c);
      }
      if (key === "GET /api/clients") {
        const kind = new URL(path, "http://x").searchParams.get("kind");
        return json(200, state.clients.filter((c) => !kind || c.is_wired === (kind === "wired")));
      }
      if (/^GET \/api\/devices\/\d+\/poe$/.test(key)) return json(200, state.poe);
      if (key === "GET /api/topology") return json(200, state.topology);
      if (key === "GET /api/dashboards/default") return json(200, { layout: state.layout, updated_at: null });
      if (key === "PUT /api/dashboards/default") {
        state.layout = body as DashboardLayout;
        return json(200, { layout: state.layout, updated_at: new Date().toISOString() });
      }
      if (key === "DELETE /api/dashboards/default") {
        state.layout = null;
        return json(204);
      }
      if (key === "GET /api/devices/1/interfaces") return json(200, [{ id: 11, label: "Port 1", alias: "AP U6+" }, { id: 12, label: "Port 2", alias: null }]);
      if (key === "GET /api/devices/1/wifi") return json(200, [{ id: 21, ssid: "Dom", radio: "ng" }]);
      if (/^GET \/api\/(interfaces|wifi|devices)\/\d+\/metrics$/.test(key)) return json(200, state.traffic.points);
      if (key === "GET /api/updates/settings") return json(200, state.updateSettings);
      if (key === "PUT /api/updates/settings") {
        if (!state.admin) return json(403, { detail: "Wymagane uprawnienia administratora" });
        state.updateSettings = body as UpdateSettings;
        return json(200, state.updateSettings);
      }
      if (key === "GET /api/updates") return json(200, state.updates);
      if (key === "POST /api/updates/check") {
        state.updates = state.afterCheck ?? state.updates;
        return json(200, state.updates);
      }
      if (key === "POST /api/updates/apply") {
        state.updates = state.afterApply ?? { ...state.updates, job: RUNNING_JOB };
        return json(202, state.updates);
      }
      if (key === "POST /api/probe") return json(200, state.probe);
      if (key === "POST /api/devices") {
        const b = body as Partial<Device> & { host: string; name: string };
        if (state.devices.some((d) => d.host === b.host)) return json(409, { detail: `Urządzenie ${b.host} już jest dodane` });
        const created: Device = {
          ...DEVICE,
          id: Math.max(0, ...state.devices.map((d) => d.id)) + 1,
          name: b.name,
          host: b.host,
          port: b.port ?? 161,
          driver: b.driver ?? "auto",
          snmp_version: b.snmp_version ?? "2c",
          v3_username: b.v3_username ?? null,
          v3_auth_protocol: b.v3_auth_protocol ?? null,
          v3_priv_protocol: b.v3_priv_protocol ?? null,
          v3_context: b.v3_context ?? null,
          enabled: b.enabled ?? true,
          status: "unknown",
          last_polled_at: null,
        };
        state.devices.push(created);
        return json(201, created);
      }
      const match = /^(GET|PATCH|DELETE|POST) \/api\/devices\/(\d+)(\/probe)?$/.exec(key);
      if (match) {
        const device = state.devices.find((d) => d.id === Number(match[2]));
        if (!device) return json(404, { detail: "Nie ma takiego urządzenia" });
        if (match[3]) return match[1] === "POST" ? json(200, state.probe) : json(404, { detail: "Not Found" });
        if (match[1] === "GET") return json(200, device);
        if (match[1] === "DELETE") {
          state.devices = state.devices.filter((d) => d !== device);
          return json(204);
        }
        if (match[1] === "PATCH") {
          const { community: _c, v3_auth_key: _a, v3_priv_key: _p, ...fields } = body as Record<string, unknown>;
          Object.assign(device, fields);
          return json(200, device);
        }
      }
    }

    switch (key) {
      case "GET /api/auth/status":
        return json(200, status());
      case "POST /api/auth/setup":
        state.setupRequired = false;
        state.authenticated = true;
        return json(201, USER);
      case "POST /api/auth/login":
        state.authenticated = true;
        return json(200, USER);
      case "POST /api/auth/logout":
        state.authenticated = false;
        return json(204);
      case "POST /api/auth/password":
        return json(204);
      case "GET /api/dashboard/summary":
        return json(200, state.summary);
      case "GET /api/dashboard/traffic":
        return json(200, state.traffic);
      case "GET /api/dashboard/wifi":
        return json(200, state.wifi);
      case "GET /api/devices":
        return state.authenticated ? json(200, state.devices) : json(401, { detail: "Wymagane logowanie" });
      default:
        return json(404, { detail: "Not Found" });
    }
  };

  const fetchMock = vi.fn(impl);
  vi.stubGlobal("fetch", fetchMock);
  return { state, calls, fetchMock };
}
