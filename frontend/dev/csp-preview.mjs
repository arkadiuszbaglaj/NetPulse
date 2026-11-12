// Podgląd zbudowanego panelu (frontend/dist) z tym samym nagłówkiem Content-Security-Policy, który wysyła API
// (backend/netpulse/api/web.py: content_security_policy) – do sprawdzenia w przeglądarce, czy polityka niczego
// nie blokuje. Zapytania /api idą do atrapy (npm run mock, port 8000).
//   npm run build && npm run mock   +   node dev/csp-preview.mjs   (port 4180)
// Lista dyrektyw musi być taka sama jak w web.py – po zmianie tam poprawić tutaj.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT ?? 4180);
const API = new URL(process.env.NETPULSE_API ?? "http://127.0.0.1:8000");
const DIST = fileURLToPath(new URL("../dist/", import.meta.url));
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};

const index = await readFile(join(DIST, "index.html"), "utf-8");
const hashes = [...index.matchAll(/<script(?![^>]*\bsrc=)[^>]*>(.*?)<\/script>/gis)]
  .map((m) => m[1])
  .filter((body) => body.trim())
  .map((body) => `'sha256-${createHash("sha256").update(body, "utf-8").digest("base64")}'`);
const CSP = [
  "default-src 'self'",
  ["script-src 'self'", ...hashes].join(" "),
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "form-action 'self'",
].join("; ");

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (url.pathname.startsWith("/api/")) {
    const upstream = httpRequest(
      { host: API.hostname, port: API.port, path: req.url, method: req.method, headers: req.headers },
      (r) => {
        res.writeHead(r.statusCode ?? 502, { ...r.headers, "Content-Security-Policy": CSP });
        r.pipe(res);
      },
    );
    upstream.on("error", () => res.writeHead(502).end("atrapa API nie działa (npm run mock)"));
    req.pipe(upstream);
    return;
  }
  const path = normalize(join(DIST, decodeURIComponent(url.pathname)));
  let file = path.startsWith(DIST) && extname(path) ? path : join(DIST, "index.html");
  let body;
  try {
    body = await readFile(file);
  } catch {
    file = join(DIST, "index.html");
    body = await readFile(file);
  }
  res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Content-Security-Policy": CSP });
  res.end(body);
}).listen(PORT, () => console.log(`Panel z CSP: http://localhost:${PORT}\n${CSP}`));
