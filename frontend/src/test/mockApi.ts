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
import type { Agent } from "../lib/agents";
import type { BackupsResponse } from "../lib/backups";
import type { Modules } from "../lib/modules";
import type { ProxmoxGuest, ProxmoxServer, ProxmoxStorage } from "../lib/proxmox";
import type { Alert, AlertRule } from "../lib/alerts";
import type { DashboardLayout } from "../lib/layout";
import type { NotificationChannel } from "../lib/notifications";
import type { ServerStatus } from "../components/widgets/ServerDetails";
import type { SystemInfo } from "../lib/system";
import type { Topology } from "../lib/topology";
import type { Controller, NetworkClient, PoeInfo } from "../lib/unifi";
import type { WanHistory, WanLink, WanSla, WanStatus } from "../lib/wan";
import type { Availability, InterfaceDetail } from "../lib/details";
import type { DashboardFull, PublicDashboard, PublicPayload } from "../lib/dashboards";

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

export const AGENT: Agent = {
  id: 1,
  device_id: 7,
  name: "NAS",
  enabled: true,
  status: "up",
  token_hint: "Ab3x",
  created_at: "2026-10-25T10:00:00Z",
  last_seen_at: new Date().toISOString(),
  last_ip: "192.168.1.30",
  agent_version: "0.11.0",
  outdated: false,
  hostname: "nas",
};

export const PVE_SERVER: ProxmoxServer = {
  id: 1,
  name: "Homelab",
  host: "192.168.1.10",
  port: 8006,
  token_id: "netpulse@pve!monitor",
  verify_tls: false,
  enabled: true,
  status: "up",
  version: "8.2.4",
  cluster_name: "homelab",
  last_polled_at: new Date().toISOString(),
  last_ok_at: new Date().toISOString(),
  last_error: null,
  created_at: "2026-10-25T10:00:00Z",
};

export const AVAILABILITY: Availability = { days: 30, percent: 99.5, samples: 1000, down_s: 150, daily: [] };

export const PORT: InterfaceDetail = {
  id: 11,
  if_index: 1,
  name: "0/1",
  label: "Port 1",
  alias: "AP U6+",
  role: "port",
  hidden: false,
  mac: null,
  admin_up: true,
  oper_status: "up",
  speed_mbps: 1000,
  in_bps: 12_000_000,
  out_bps: 3_000_000,
  device_id: 1,
  device_name: "UCG Ultra",
  device_kind: "switch",
  last_seen_at: new Date().toISOString(),
  poe_port_idx: 1,
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
  agents: Agent[];
  backups: BackupsResponse;
  modules: Modules;
  pveServers: ProxmoxServer[];
  pveGuests: ProxmoxGuest[];
  pveStorages: ProxmoxStorage[];
  alerts: Alert[];
  rules: AlertRule[];
  clients: NetworkClient[];
  poe: PoeInfo;
  topology: Topology;
  /** Ostatnia próbka stanu serwera (null = kolektor jeszcze jej nie zapisał) */
  system: SystemInfo | null;
  /** Stan serwera Linux (odpowiedź /api/devices/{id}/server) */
  server: ServerStatus | null;
  channels: NotificationChannel[];
  /** Odpowiedź na wiadomość próbną kanału */
  channelTest: { ok: boolean; error: string | null };
  services: { id: string; state: string; detail: string | null }[];
  /** Łącza WAN (dual WAN): stan, historia, SLA i konfiguracja */
  wanStatus: WanStatus;
  wanHistory: WanHistory;
  wanSla: WanSla;
  wanLinks: WanLink[];
  /** Dostępność (ta sama odpowiedź dla każdego okresu, urządzenia i portu) */
  availability: Availability;
  /** Port z GET /api/interfaces/{id} */
  port: InterfaceDetail;
  /** Zapisane pulpity (Ustawienia → Dashboardy) */
  dashboards: DashboardFull[];
  /** Pulpit publiczny pod /p/<token> (null = link nieaktywny) i jego PIN */
  publicDashboard: PublicDashboard | null;
  publicPin: string | null;
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
    agents: [],
    backups: { backups: [], restore: { state: "idle" } },
    modules: { proxmox: true, unifi: true, agents: true, backups: true },
    pveServers: [],
    pveGuests: [],
    pveStorages: [],
    alerts: [],
    rules: [],
    clients: [],
    poe: { budget: null, ports: [] },
    topology: { nodes: [], edges: [] },
    system: null,
    server: null,
    channels: [],
    channelTest: { ok: true, error: null },
    services: [
      { id: "api", state: "ok", detail: "0.8.2" },
      { id: "database", state: "ok", detail: "timescaledb" },
      { id: "collector", state: "ok", detail: null },
      { id: "unifi", state: "off", detail: "not_configured" },
      { id: "updater", state: "ok", detail: null },
    ],
    updateSettings: { auto_check: true, interval_h: 24 },
    wanStatus: { links: [], active_ids: [] },
    wanHistory: { interval_s: 30, links: [], points: [], segments: [], switches: [] },
    wanSla: { days: 7, start: "2026-10-18T12:00:00Z", end: "2026-10-25T12:00:00Z", links: [] },
    wanLinks: [],
    updates: UPDATES,
    availability: AVAILABILITY,
    port: PORT,
    dashboards: [],
    publicDashboard: null,
    publicPin: null,
    overrides: {},
    ...initial,
  };
  // Kopie urządzeń: PATCH zmienia obiekty, a testy nie mogą sobie nawzajem psuć wspólnego DEVICE
  state.devices = state.devices.map((d) => ({ ...d }));
  // Kopie kanałów: PATCH zmienia obiekty, a stała z testu nie może się zmieniać między testami
  state.channels = state.channels.map((c) => ({ ...c }));
  const calls: Call[] = [];

  const status = (): AuthStatus => ({
    setup_required: state.setupRequired,
    authenticated: state.authenticated && !state.setupRequired,
    user: state.authenticated && !state.setupRequired ? { ...USER, is_admin: state.admin } : null,
    version: "0.2.0",
  });

  const impl = async (input: RequestInfo | URL, init?: RequestInit, publicCall = false): Promise<Response> => {
    const path = String(input);
    const method = init?.method ?? "GET";
    // Treść JSON; plik (np. wgrywana kopia) zostaje jak jest
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
    calls.push({ method, path, body });
    // Klucz bez parametrów zapytania; pełna ścieżka zostaje w `calls`
    const key = `${method} ${path.split("?")[0]}`;

    const override = state.overrides[key];
    if (override) return json(override.status, override.body);

    // Urządzenia: dodawanie, test, edycja i usuwanie (sekrety z żądań nie wracają w odpowiedziach)
    // Pulpit publiczny: bez logowania; dane widgetów przez /data?path=… (z PIN-em – z kluczem dostępu)
    const pub = /^(GET|POST) \/api\/public\/dashboards\/([^/]+)(\/data|\/unlock)?$/.exec(key);
    if (pub) {
      const d = state.publicDashboard;
      if (!d) return json(404, { detail: "Ten link jest nieaktywny albo wygasł" });
      const headers = new Headers(init?.headers);
      const unlocked = state.publicPin == null || headers.get("X-Dashboard-Access") === "klucz-dostepu";
      if (pub[3] === "/unlock") {
        return (body as { pin: string }).pin === state.publicPin ? json(200, { access: "klucz-dostepu" }) : json(403, { detail: "Nieprawidłowy PIN" });
      }
      if (pub[3] === "/data") {
        if (!unlocked) return json(401, { detail: "Ten pulpit wymaga PIN-u" });
        const inner = new URL(path, "http://x").searchParams.get("path") ?? "";
        return impl(inner, { method: "GET" }, true);
      }
      return json(200, unlocked ? d : { ...d, locked: true, layout: null });
    }

    if (state.authenticated) {
      const dash = /^(GET|PATCH|DELETE|POST|PUT) \/api\/dashboards(?:\/(\d+))?(\/default|\/public|\/public\/rotate)?$/.exec(key);
      if (dash && !(dash[2] === undefined && dash[3] === "/default")) {
        const [, m, idRaw, sub] = dash;
        if (!idRaw) {
          if (m === "GET") return json(200, state.dashboards.map(({ layout: _l, ...info }) => info));
          const b = body as { name: string; layout: DashboardLayout; make_default?: boolean };
          const created: DashboardFull = {
            id: Math.max(0, ...state.dashboards.map((x) => x.id)) + 1,
            name: b.name,
            is_default: b.make_default ?? false,
            widgets: b.layout.widgets.length,
            updated_at: new Date().toISOString(),
            public: null,
            layout: b.layout,
          };
          state.dashboards.push(created);
          return json(201, created);
        }
        const found = state.dashboards.find((x) => x.id === Number(idRaw));
        if (!found) return json(404, { detail: "Nie ma takiego pulpitu" });
        if (sub === "/default") {
          state.dashboards.forEach((x) => (x.is_default = x === found));
          return json(200, found);
        }
        if (sub === "/public") {
          const b = body as PublicPayload;
          found.public = b.enabled
            ? { token: found.public?.token ?? `tok${found.id}-abcdefghijklmnopqrstuvwxyz`, expires_at: b.expires_at ?? null, expired: false, has_pin: Boolean(b.pin) || (!b.clear_pin && Boolean(found.public?.has_pin)), options: b.options ?? { refresh_s: 30, range_min: 60, hide_hosts: true } }
            : null;
          return json(200, found);
        }
        if (sub === "/public/rotate" && found.public) {
          found.public = { ...found.public, token: `${found.public.token}-nowy` };
          return json(200, found);
        }
        if (m === "GET") return json(200, found);
        if (m === "DELETE") {
          state.dashboards = state.dashboards.filter((x) => x !== found);
          return json(204);
        }
        if (m === "PATCH") {
          Object.assign(found, body as object);
          return json(200, found);
        }
      }
    }

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
          unacked_critical: firing.filter((a) => !a.acked_at && a.severity === "critical").length,
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
          { metric: "temp_c", label: "Temperatura (każdy czujnik serwera z agentem)", unit: "°C", per_device: true, matchable: true },
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
      if (key === "GET /api/modules") return json(200, state.modules);
      if (key === "PUT /api/modules") {
        state.modules = { ...state.modules, ...(body as Partial<Modules>) };
        return json(200, state.modules);
      }
      if (key === "GET /api/proxmox/servers") return json(200, state.pveServers);
      if (key === "GET /api/proxmox/guests") return json(200, state.pveGuests);
      if (key === "GET /api/proxmox/storages") return json(200, state.pveStorages);
      if (key === "POST /api/proxmox/probe" || /^POST \/api\/proxmox\/servers\/\d+\/probe$/.test(key)) {
        return json(200, { version: "8.2.4", cluster: "homelab", nodes: 2, guests: 5, storages: 4 });
      }
      if (key === "POST /api/proxmox/servers") {
        const b = body as Partial<ProxmoxServer> & { token_secret: string };
        const { token_secret: _secret, ...fields } = b;
        const created: ProxmoxServer = { ...PVE_SERVER, ...fields, id: state.pveServers.length + 1, status: "unknown", version: null, cluster_name: null } as ProxmoxServer;
        state.pveServers.push(created);
        return json(201, created);
      }
      const pve = /^(PATCH|DELETE) \/api\/proxmox\/servers\/(\d+)$/.exec(key);
      if (pve) {
        const s = state.pveServers.find((x) => x.id === Number(pve[2]));
        if (!s) return json(404, { detail: "Nie ma takiego serwera Proxmox" });
        if (pve[1] === "DELETE") {
          state.pveServers = state.pveServers.filter((x) => x !== s);
          return json(204);
        }
        const { token_secret: _secret, ...fields } = body as Record<string, unknown>;
        Object.assign(s, fields);
        return json(200, s);
      }
      if (key === "GET /api/backups") return json(200, state.backups);
      if (key === "POST /api/backups/upload") {
        const created = { name: "netpulse-upload-20261025-130000.sql.gz", kind: "upload" as const, size_bytes: 1_000_000, created_at: "2026-10-25T13:00:00+02:00" };
        state.backups = { ...state.backups, backups: [created, ...state.backups.backups] };
        return json(201, state.backups);
      }
      if (key === "POST /api/backups") {
        const created = { name: "netpulse-manual-20261025-120000.sql.gz", kind: "manual" as const, size_bytes: 2_500_000, created_at: "2026-10-25T12:00:00+02:00" };
        state.backups = { ...state.backups, backups: [created, ...state.backups.backups] };
        return json(201, state.backups);
      }
      const backup = /^(DELETE|POST) \/api\/backups\/([^/]+?)(\/restore)?$/.exec(key);
      if (backup) {
        const name = decodeURIComponent(backup[2]);
        if (!state.backups.backups.some((b) => b.name === name)) return json(404, { detail: "Nie ma takiej kopii" });
        if (backup[3]) {
          state.backups = { ...state.backups, restore: { state: "running", backup: name, step: "safety" } };
          return json(202, state.backups);
        }
        state.backups = { ...state.backups, backups: state.backups.backups.filter((b) => b.name !== name) };
        return json(200, state.backups);
      }
      if (key === "GET /api/agents") return json(200, state.agents);
      if (key === "POST /api/agents") {
        const b = body as { name: string };
        const id = Math.max(0, ...state.agents.map((a) => a.id)) + 1;
        const token = `npa_test${id}tokenXyZ9`;
        const created: Agent = { ...AGENT, id, device_id: 100 + id, name: b.name, status: "unknown", last_seen_at: null, last_ip: null, agent_version: null, hostname: null, token_hint: token.slice(-4) };
        state.agents.push(created);
        return json(201, { agent: created, token });
      }
      const agentToken = /^POST \/api\/agents\/(\d+)\/token$/.exec(key);
      if (agentToken) {
        const found = state.agents.find((a) => a.id === Number(agentToken[1]));
        if (!found) return json(404, { detail: "Nie ma takiego agenta" });
        const token = `npa_rotated${found.id}NeW1`;
        found.token_hint = token.slice(-4);
        return json(200, { agent: found, token });
      }
      const agentDevice = /^DELETE \/api\/devices\/(\d+)$/.exec(key);
      if (agentDevice && state.agents.some((a) => a.device_id === Number(agentDevice[1]))) {
        state.agents = state.agents.filter((a) => a.device_id !== Number(agentDevice[1]));
        state.devices = state.devices.filter((d) => d.id !== Number(agentDevice[1]));
        return json(204);
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
      if (/^GET \/api\/devices\/\d+\/server$/.test(key)) return json(200, state.server);
      if (/^GET \/api\/devices\/\d+\/agent-keys$/.test(key)) {
        return json(200, {
          agent_net: ["eth0"],
          agent_disk: ["sda"],
          agent_temp: ["coretemp/Core 0"],
          agent_container: ["nextcloud", "db"],
          pve_guest: ["homeassistant (100)", "nextcloud (105)"],
        });
      }
      if (/^GET \/api\/devices\/\d+\/agent-metrics$/.test(key)) return json(200, state.traffic.points);
      if (key === "GET /api/notification-channels") return json(200, state.channels);
      if (key === "POST /api/notification-channels") {
        const b = body as Partial<NotificationChannel> & { name: string; url?: string; secret?: string };
        const kind = b.kind ?? "webhook";
        const created: NotificationChannel = {
          id: Math.max(0, ...state.channels.map((c) => c.id)) + 1,
          name: b.name,
          kind,
          url_hint: kind === "email" && b.email ? `${b.email.host}:${b.email.port}` : `${new URL(b.url ?? "http://x").origin}/…`,
          has_secret: Boolean(b.secret),
          email: b.email ?? null,
          enabled: true,
          min_severity: (b.min_severity ?? "warning") as NotificationChannel["min_severity"],
          notify_resolved: b.notify_resolved ?? true,
          quiet_from: b.quiet_from ?? null,
          quiet_to: b.quiet_to ?? null,
          quiet_critical: b.quiet_critical ?? true,
          quiet_pending: 0,
          timezone: "Europe/Warsaw",
          last_status: null,
          last_error: null,
          last_sent_at: null,
          created_at: "2026-10-25T10:00:00Z",
        };
        state.channels.push(created);
        return json(201, created);
      }
      const channel = /^(PATCH|DELETE|POST) \/api\/notification-channels\/(\d+)(\/test)?$/.exec(key);
      if (channel) {
        const found = state.channels.find((c) => c.id === Number(channel[2]));
        if (!found) return json(404, { detail: "Nie ma takiego kanału" });
        if (channel[3]) return json(200, state.channelTest);
        if (channel[1] === "DELETE") {
          state.channels = state.channels.filter((c) => c !== found);
          return json(204);
        }
        const { url: _url, secret, ...fields } = body as Record<string, unknown>;
        if (secret !== undefined) found.has_secret = Boolean(secret);
        Object.assign(found, fields);
        return json(200, found);
      }
      if (key === "GET /api/wan/status") return json(200, state.wanStatus);
      if (key === "GET /api/wan/history") return json(200, state.wanHistory);
      if (key === "GET /api/wan/sla") {
        const days = Number(new URL(path, "http://x").searchParams.get("days") ?? 1);
        return json(200, { ...state.wanSla, days });
      }
      if (key === "GET /api/wan/links") return json(200, state.wanLinks);
      if (key === "PUT /api/wan/links") {
        if (!state.admin) return json(403, { detail: "Wymagane uprawnienia administratora" });
        const items = (body as { links: { interface_id: number; name: string }[] }).links;
        state.wanLinks = items.map((x, i) => {
          const known = state.wanLinks.find((l) => l.interface_id === x.interface_id);
          return {
            ...(known ?? { id: 100 + i, device_id: 1, device_name: "UCG Ultra", interface_name: `if${x.interface_id}`, interface_label: `Port ${x.interface_id}`, speed_mbps: 1000, state: "unknown", state_since: null, source: null, in_bps: null, out_bps: null, sampled_at: null }),
            interface_id: x.interface_id,
            name: x.name,
            position: i + 1,
          } as WanLink;
        });
        return json(200, state.wanLinks);
      }
      if (key === "GET /api/system") return json(200, state.system);
      if (key === "GET /api/system/services") return json(200, state.services);
      if (key === "GET /api/system/metrics") return json(200, state.traffic.points);
      if (key === "GET /api/dashboards/default") return json(200, { layout: state.layout, updated_at: null });
      if (key === "PUT /api/dashboards/default") {
        state.layout = body as DashboardLayout;
        return json(200, { layout: state.layout, updated_at: new Date().toISOString() });
      }
      if (key === "DELETE /api/dashboards/default") {
        state.layout = null;
        return json(204);
      }
      const clientMatch = /^GET \/api\/clients\/([0-9a-f:]{17})(\/(metrics|presence|events))?$/.exec(key);
      if (clientMatch) {
        const c = state.clients.find((x) => x.mac === clientMatch[1]);
        if (!c) return json(404, { detail: "Nie ma takiego klienta" });
        const minuteAgo = new Date(Date.now() - 60_000).toISOString();
        switch (clientMatch[3]) {
          case "metrics":
            return json(200, [{ time: minuteAgo, values: { signal_dbm: c.signal_dbm, rx_rate_kbps: c.rx_rate_kbps, tx_rate_kbps: c.tx_rate_kbps } }]);
          case "presence":
            return json(200, { interval_s: 30, expected: 1, buckets: [{ time: minuteAgo, samples: 1 }] });
          case "events":
            return json(200, [
              { time: minuteAgo, kind: "roam", uplink_device_id: c.uplink_device_id, uplink_name: c.uplink_name, uplink_port: null, essid: c.essid, radio: c.radio, gap_s: null },
            ]);
          default:
            return json(200, {
              mac: c.mac,
              name: c.name,
              ip: c.ip,
              is_wired: c.is_wired,
              is_guest: c.is_guest,
              online: true,
              first_seen_at: "2026-10-01T10:00:00Z",
              last_seen_at: c.updated_at,
              current: c,
            });
        }
      }
      if (key === "GET /api/availability") return json(200, state.devices.map((d) => ({ device_id: d.id, percent: state.availability.percent, samples: state.availability.samples })));
      if (/^GET \/api\/(devices|interfaces)\/\d+\/availability$/.test(key)) return json(200, state.availability);
      if (/^GET \/api\/interfaces\/\d+\/poe-metrics$/.test(key)) return json(200, [{ time: "2026-10-24T20:00:00Z", values: { power_w: 4.5 } }]);
      const iface = /^GET \/api\/interfaces\/(\d+)$/.exec(key);
      if (iface) return Number(iface[1]) === state.port.id ? json(200, state.port) : json(404, { detail: "Nie ma takiego portu" });
      if (key === "GET /api/devices/1/interfaces") return json(200, [{ id: 11, name: "eth0", label: "Port 1", alias: "AP U6+" }, { id: 12, name: "eth1", label: "Port 2", alias: null }]);
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
        return state.authenticated || publicCall ? json(200, state.devices) : json(401, { detail: "Wymagane logowanie" });
      default:
        return json(404, { detail: "Not Found" });
    }
  };

  const fetchMock = vi.fn(impl);
  vi.stubGlobal("fetch", fetchMock);
  return { state, calls, fetchMock };
}
