import { vi } from "vitest";
import type { AuthStatus, Device, User } from "../lib/api";

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

export interface Call {
  method: string;
  path: string;
  body: unknown;
}

interface MockState {
  setupRequired: boolean;
  authenticated: boolean;
  devices: Device[];
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
  const state: MockState = { setupRequired: false, authenticated: true, devices: [DEVICE], overrides: {}, ...initial };
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
    const key = `${method} ${path}`;

    const override = state.overrides[key];
    if (override) return json(override.status, override.body);

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
