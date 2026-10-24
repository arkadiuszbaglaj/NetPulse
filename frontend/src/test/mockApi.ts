import { vi } from "vitest";
import type { AuthStatus, DashboardSummary, Device, ProbeResult, Series, User } from "../lib/api";

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
    overrides: {},
    ...initial,
  };
  // Kopie urządzeń: PATCH zmienia obiekty, a testy nie mogą sobie nawzajem psuć wspólnego DEVICE
  state.devices = state.devices.map((d) => ({ ...d }));
  const calls: Call[] = [];

  const status = (): AuthStatus => ({
    setup_required: state.setupRequired,
    authenticated: state.authenticated && !state.setupRequired,
    user: state.authenticated && !state.setupRequired ? USER : null,
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
