// Atrapa API NetPulse do rozwoju panelu bez bazy i urządzeń:
//   npm run mock   (port 8000)   +   npm run dev   (port 5173, proxy /api → 8000)
// Dane są w pamięci i znikają po restarcie. Pierwsze konto zakłada kreator, jak w prawdziwym API.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const PORT = Number(process.env.PORT ?? 8000);
const VERSION = "0.6.0";
const now = () => new Date().toISOString();
const ago = (s) => new Date(Date.now() - s * 1000).toISOString();

let user = null; // { id, username, password, ... }
let layout = null; // układ pulpitu domyślnego (null = domyślny z panelu)
let layoutAt = null;
const sessions = new Set();

const devices = [
  { id: 1, name: "UCG Ultra", host: "192.168.1.1", kind: "gateway", vendor: "Ubiquiti", model: "UCG-Ultra", status: "up", polled: 12 },
  { id: 2, name: "USW Lite 8 PoE", host: "192.168.1.2", kind: "switch", vendor: "Ubiquiti", model: "UniFi Switch", status: "up", polled: 12 },
  { id: 3, name: "U6+", host: "192.168.1.3", kind: "ap", vendor: "Ubiquiti", model: "U6+", status: "up", polled: 12 },
  { id: 4, name: "Garaż (testowy)", host: "192.168.1.9", kind: "other", vendor: null, model: null, status: "down", polled: 95, error: "192.168.1.9: No SNMP response received before timeout" },
].map((d) => ({
  port: 161, enabled: true, driver: "auto", detected_driver: "unifi", snmp_version: "2c", firmware: null, sys_name: d.name,
  uptime_s: 3_000_000, last_polled_at: ago(d.polled), last_ok_at: ago(d.polled), last_error: d.error ?? null, created_at: ago(86400 * 30), ...d,
}));

// Przebieg ruchu w Mb/s: i – numer próbki wstecz, k – 0 pobieranie, 1 wysyłanie
const wave = (i, k) => Math.max(0.2, (k === 0 ? 38 : 6) * (1 + 0.5 * Math.sin(i / 7 + k) + 0.25 * Math.sin(i / 2.3)));


// --- aktualizacja z panelu (symulacja): sprawdzanie → zmiany → postęp co 2 s → sukces ---------------------------
let installed = VERSION;
let updateInfo = null;
const idleJob = { state: "idle", phase: null, phases: [], started_at: null, finished_at: null, from_version: null, to_version: null, from_commit: null, to_commit: null, error: null, note: null, log: [] };
let job = { ...idleJob };
const PHASES = ["prepare", "backup", "fetch", "build", "start", "verify"];
const updatesView = () => ({
  installed_version: installed,
  updater: { configured: true, reachable: true, message: null },
  current: { version: installed, commit: installed === VERSION ? "abc1234" : "def5678", branch: "main" },
  info: updateInfo,
  job,
});
function startSimulation() {
  let i = 0;
  job = {
    ...idleJob, state: "running", phase: PHASES[0], started_at: now(), from_version: installed, to_version: "9.9.9", from_commit: "abc1234", to_commit: "def5678",
    phases: PHASES.map((id, n) => ({ id, status: n === 0 ? "running" : "pending" })), log: ["== prepare", "Wolne miejsce: 41000 MB (wymagane co najmniej 2000 MB)"],
  };
  const timer = setInterval(() => {
    job.phases[i].status = "done";
    i += 1;
    if (i >= PHASES.length) {
      clearInterval(timer);
      installed = "9.9.9";
      updateInfo = null;
      job = { ...job, state: "ok", phase: null, finished_at: now(), log: [...job.log, "Aktualizacja zakończona"] };
      return;
    }
    job.phases[i].status = "running";
    job.phase = PHASES[i];
    job.log = [...job.log, `== ${PHASES[i]}`];
  }, 2000);
}

const publicUser = () => user && { id: 1, username: user.username, is_admin: true, created_at: user.created, last_login_at: user.lastLogin };
const send = (res, code, body, headers = {}) => {
  res.writeHead(code, { "Content-Type": "application/json", ...headers });
  res.end(body === undefined ? undefined : JSON.stringify(body));
};
const readBody = (req) => new Promise((resolve) => {
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", () => { try { resolve(JSON.parse(data || "{}")); } catch { resolve({}); } });
});
const token = (req) => /netpulse_session=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
const authed = (req) => sessions.has(token(req));
const startSession = (res) => {
  const t = randomBytes(16).toString("hex");
  sessions.add(t);
  user.lastLogin = now();
  return { "Set-Cookie": `netpulse_session=${t}; HttpOnly; SameSite=Lax; Path=/` };
};

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const route = `${req.method} ${url.pathname}`;
  const body = ["POST", "PATCH", "PUT"].includes(req.method) ? await readBody(req) : {};

  if (route === "GET /api/health") return send(res, 200, { status: "ok", version: VERSION, timescaledb: true });
  if (route === "GET /api/auth/status") {
    return send(res, 200, { setup_required: !user, authenticated: !!user && authed(req), user: user && authed(req) ? publicUser() : null, version: VERSION });
  }
  if (route === "POST /api/auth/setup") {
    if (user) return send(res, 409, { detail: "Konto administratora już istnieje – zaloguj się" });
    if ((body.password ?? "").length < 8) return send(res, 422, { detail: "Hasło musi mieć co najmniej 8 znaków" });
    user = { username: body.username, password: body.password, created: now(), lastLogin: null };
    return send(res, 201, publicUser(), startSession(res));
  }
  if (route === "POST /api/auth/login") {
    if (!user || body.username !== user.username || body.password !== user.password) return send(res, 401, { detail: "Nieprawidłowy login lub hasło" });
    return send(res, 200, publicUser(), startSession(res));
  }
  if (route === "POST /api/auth/logout") {
    sessions.delete(token(req));
    return send(res, 204, undefined, { "Set-Cookie": "netpulse_session=; Max-Age=0; Path=/" });
  }
  if (!authed(req)) return send(res, 401, { detail: "Wymagane logowanie" });
  if (route === "GET /api/auth/me") return send(res, 200, publicUser());
  if (route === "POST /api/auth/password") {
    if (body.current_password !== user.password) return send(res, 403, { detail: "Obecne hasło jest nieprawidłowe" });
    user.password = body.new_password;
    return send(res, 204);
  }
  if (route === "GET /api/dashboard/summary") {
    const up = devices.filter((d) => d.status === "up").length;
    return send(res, 200, {
      devices: { total: devices.length, up, down: devices.length - up, unknown: 0 },
      wan: { in_bps: wave(0, 0) * 1e6, out_bps: wave(0, 1) * 1e6, interfaces: 1 },
      wifi_clients: 17,
      last_poll_at: ago(12),
      poll_interval_s: 30,
    });
  }
  if (route === "GET /api/dashboard/traffic" || route === "GET /api/dashboard/wifi") {
    const minutes = Number(url.searchParams.get("minutes") ?? 60);
    const stride = Math.max(30, Math.floor((minutes * 60) / 300));
    const n = Math.floor((minutes * 60) / stride);
    const points = [];
    for (let i = n; i >= 0; i--) {
      if (i > n * 0.55 && i < n * 0.62) continue; // przerwa w danych – urządzenie nie odpowiadało
      const time = new Date(Date.now() - i * stride * 1000).toISOString();
      const values = route.endsWith("traffic")
        ? { in_bps: wave(i, 0) * 1e6, out_bps: wave(i, 1) * 1e6 }
        : { clients: Math.round(12 + 5 * Math.sin(i / 9) + (i % 3)) };
      points.push({ time, values });
    }
    return send(res, 200, { interval_s: stride, points });
  }
  const idMatch = /^\/api\/devices\/(\d+)(\/probe)?$/.exec(url.pathname);
  if (route === "POST /api/probe" || (idMatch?.[2] && req.method === "POST")) {
    await new Promise((r) => setTimeout(r, 700)); // test SNMP chwilę trwa
    if (body.host === "192.168.1.9" || (idMatch && devices.find((d) => d.id === Number(idMatch[1]))?.status === "down")) {
      return send(res, 422, { detail: `Brak odpowiedzi SNMP z ${body.host ?? "urządzenia"}: No SNMP response received before timeout` });
    }
    return send(res, 200, {
      driver: "unifi", name: "USW-Switch", vendor: "Ubiquiti", model: "UniFi Switch", firmware: null, kind: "switch", uptime_s: 3_950_000,
      interfaces: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ if_index: n, name: `0/${n}`, label: `Port ${n}`, alias: null, role: "port", hidden: false, oper_status: "up", speed_mbps: 1000 })),
      wifi: [],
    });
  }
  if (route === "POST /api/devices") {
    if (devices.some((d) => d.host === body.host)) return send(res, 409, { detail: `Urządzenie ${body.host} już jest dodane` });
    if (url.searchParams.get("probe") !== "false" && body.host === "192.168.1.9") {
      return send(res, 422, { detail: `Brak odpowiedzi SNMP z ${body.host}: No SNMP response received before timeout` });
    }
    const device = {
      id: Math.max(0, ...devices.map((d) => d.id)) + 1, name: body.name, host: body.host, port: body.port ?? 161, enabled: true,
      driver: body.driver ?? "auto", detected_driver: null, snmp_version: body.snmp_version ?? "2c", v3_username: body.v3_username ?? null,
      v3_auth_protocol: body.v3_auth_protocol ?? null, v3_priv_protocol: body.v3_priv_protocol ?? null, v3_context: body.v3_context ?? null,
      kind: "other", vendor: null, model: null, firmware: null, sys_name: null, uptime_s: null, status: "unknown", last_polled_at: null,
      last_ok_at: null, last_error: null, created_at: now(),
    };
    devices.push(device);
    return send(res, 201, device);
  }
  if (idMatch && !idMatch[2] && (req.method === "PATCH" || req.method === "DELETE")) {
    const body2 = body;
    const i = devices.findIndex((d) => d.id === Number(idMatch[1]));
    if (i < 0) return send(res, 404, { detail: "Nie ma takiego urządzenia" });
    if (req.method === "DELETE") { devices.splice(i, 1); return send(res, 204); }
    const { community, v3_auth_key, v3_priv_key, ...fields } = body2;
    Object.assign(devices[i], fields);
    return send(res, 200, devices[i]);
  }
  if (route === "GET /api/updates") return send(res, 200, updatesView());
  if (route === "POST /api/updates/check") {
    await new Promise((r) => setTimeout(r, 900));
    updateInfo = installed === "9.9.9"
      ? { current: { version: installed, commit: "def5678" }, latest: { version: installed, commit: "def5678" }, behind: 0, ahead: 0, diverged: false, update_available: false, changes: [], checked_at: now() }
      : {
          current: { version: installed, commit: "abc1234" }, latest: { version: "9.9.9", commit: "def5678" }, behind: 3, ahead: 0, diverged: false, update_available: true, checked_at: now(),
          changes: [
            { sha: "def5678", subject: "Etap 5d: aktualizacja jednym kliknięciem" },
            { sha: "b0c1d2e", subject: "Kontrola miejsca na dysku w install.sh i netpulse update" },
            { sha: "9a8b7c6", subject: "Etap 5c: ustawienia – zarządzanie urządzeniami z panelu" },
          ],
        };
    return send(res, 200, updatesView());
  }
  if (route === "POST /api/updates/apply") {
    if (job.state === "running") return send(res, 409, { detail: "Aktualizacja już trwa." });
    startSimulation();
    return send(res, 202, updatesView());
  }
  // --- pulpit: układ, moduły i dane paneli (wykresy, kolekcje, stany) ---
  if (route === "GET /api/modules") return send(res, 200, { proxmox: false, unifi: false, agents: false, backups: false });
  if (route === "GET /api/dashboards") return send(res, 200, []);
  if (route === "GET /api/dashboards/default") return send(res, 200, { layout, updated_at: layoutAt });
  if (route === "PUT /api/dashboards/default") {
    layout = body;
    layoutAt = now();
    return send(res, 200, { layout, updated_at: layoutAt });
  }
  if (route === "DELETE /api/dashboards/default") {
    layout = null;
    return send(res, 204);
  }
  const series = /^\/api\/(devices|interfaces|wifi)\/(\d+)\/metrics$/.exec(url.pathname) || url.pathname === "/api/system/metrics";
  if (req.method === "GET" && series) {
    const minutes = Number(url.searchParams.get("minutes") ?? 60);
    const stride = Math.max(30, Math.floor((minutes * 60) / 300));
    const points = [];
    for (let i = Math.floor((minutes * 60) / stride); i >= 0; i--) {
      const time = new Date(Date.now() - i * stride * 1000).toISOString();
      const cpu = 20 + 15 * Math.sin(i / 11) + (i % 5);
      points.push({ time, values: { cpu_percent: cpu, mem_used_percent: 48 + 4 * Math.sin(i / 23), load1: cpu / 40, poll_ms: 40 + (i % 7) * 3, in_bps: wave(i, 0) * 4e5, out_bps: wave(i, 1) * 4e5, clients: 5 + (i % 4), disk_used_percent: 63, temp_c: 52 + (i % 6) } });
    }
    return send(res, 200, points);
  }
  const coll = /^\/api\/collections\/(\w+)$/.exec(url.pathname);
  if (req.method === "GET" && coll) {
    const kind = coll[1];
    const rows =
      kind === "devices"
        ? devices.map((d, i) => ({ key: String(d.id), label: d.name, device_id: d.id, values: { up: d.status === "up" ? 1 : 0, cpu_percent: d.status === "up" ? 15 + i * 22 : null, mem_used_percent: d.status === "up" ? 40 + i * 9 : null, poll_ms: 45, uptime_s: d.uptime_s } }))
        : kind === "ports"
          ? [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ key: String(n), label: `Port ${n}`, device_id: 2, values: { up: n === 6 ? 0 : 1, in_bps: n * 3e6, out_bps: n * 1e6, speed_mbps: n === 7 ? 100 : 1000 } }))
          : [["/", 35], ["/boot", 22], ["/mnt/data", 91], ["/mnt/backup", 74]].map(([m, p]) => ({ key: m, label: m, device_id: 1, values: { used_percent: p, used_bytes: p * 1e10, free_bytes: (100 - p) * 1e10, total_bytes: 1e12 } }));
    return send(res, 200, { kind, rows });
  }
  if (route === "GET /api/states") {
    const minutes = Number(url.searchParams.get("minutes") ?? 60);
    const end = Date.now();
    const start = end - minutes * 60_000;
    const iso = (t) => new Date(t).toISOString();
    const items = devices.map((d, i) => ({
      kind: "device", id: d.id, label: d.name,
      segments: d.status === "down"
        ? [{ start: iso(start), end: iso(start + (end - start) * 0.4), state: "up" }, { start: iso(start + (end - start) * 0.4), end: iso(end), state: "down" }]
        : [{ start: iso(start), end: iso(start + (end - start) * (0.3 + i * 0.1)), state: "up" }, { start: iso(start + (end - start) * (0.3 + i * 0.1)), end: iso(start + (end - start) * (0.33 + i * 0.1)), state: "unknown" }, { start: iso(start + (end - start) * (0.33 + i * 0.1)), end: iso(end), state: "up" }],
    }));
    return send(res, 200, { start: iso(start), end: iso(end), bucket_s: 30, items });
  }
  if (route === "GET /api/devices") {
    // Czas odczytu „odświeża się” z każdym zapytaniem
    return send(res, 200, devices.map((d) => (d.status === "up" ? { ...d, last_polled_at: ago(d.polled) } : d)));
  }
  send(res, 404, { detail: "Not Found" });
}).listen(PORT, "127.0.0.1", () => console.log(`Atrapa API NetPulse: http://127.0.0.1:${PORT}`));
