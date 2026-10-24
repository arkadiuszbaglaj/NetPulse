// Atrapa API NetPulse do rozwoju panelu bez bazy i urządzeń:
//   npm run mock   (port 8000)   +   npm run dev   (port 5173, proxy /api → 8000)
// Dane są w pamięci i znikają po restarcie. Pierwsze konto zakłada kreator, jak w prawdziwym API.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const PORT = Number(process.env.PORT ?? 8000);
const VERSION = "0.4.0";
const now = () => new Date().toISOString();
const ago = (s) => new Date(Date.now() - s * 1000).toISOString();

let user = null; // { id, username, password, ... }
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
  const body = req.method === "POST" ? await readBody(req) : {};

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
  if (route === "GET /api/devices") {
    // Czas odczytu „odświeża się” z każdym zapytaniem
    return send(res, 200, devices.map((d) => (d.status === "up" ? { ...d, last_polled_at: ago(d.polled) } : d)));
  }
  send(res, 404, { detail: "Not Found" });
}).listen(PORT, "127.0.0.1", () => console.log(`Atrapa API NetPulse: http://127.0.0.1:${PORT}`));
