/** Sprawdzanie dostępności: ping, HTTP(S), port TCP, DNS (API: backend/netpulse/api/checks.py). */
import { useQuery } from "@tanstack/react-query";
import { get, type Device } from "./api";
import { useRefresh } from "./refresh";

export type CheckKind = "ping" | "http" | "tcp" | "dns";
export const CHECK_KINDS: CheckKind[] = ["ping", "http", "tcp", "dns"];
/** Typy rekordów DNS (API: DnsType w backend/netpulse/api/checks.py). */
export const DNS_TYPES = ["A", "AAAA", "CNAME", "MX", "TXT", "NS", "PTR"] as const;
export type DnsType = (typeof DNS_TYPES)[number];
/** Odstępy między sprawdzeniami do wyboru (API przyjmuje 10–3600 s). */
export const CHECK_INTERVALS = [30, 60, 120, 300, 600, 1800, 3600];

export interface CheckPayload {
  name: string;
  kind: CheckKind;
  target: string;
  port: number | null;
  interval_s: number;
  timeout_s: number;
  enabled: boolean;
  expect_status: string | null;
  keyword: string | null;
  verify_tls: boolean;
  /** DNS (od 0.64.0): typ rekordu i serwer (null = serwer systemu); `keyword` = oczekiwana odpowiedź, `port` = port serwera */
  dns_type?: DnsType | null;
  dns_server?: string | null;
}

export interface Check extends CheckPayload {
  id: number;
  status: "up" | "down" | "unknown" | string;
  /** Sprawdzenie dawno się nie wykonało (kolektor stoi) – od 0.59.0 */
  stale?: boolean;
  status_since: string | null;
  last_checked_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
  last_latency_ms: number | null;
  created_at: string;
  availability_24h: number | null;
  loss_percent: number | null;
  jitter_ms: number | null;
  status_code: number | null;
  cert_days: number | null;
  /** Ostatnia odpowiedź DNS, np. „192.0.2.1, 192.0.2.2” */
  last_answer?: string | null;
}

export interface CheckTestResult {
  up: boolean;
  latency_ms: number | null;
  loss_percent: number | null;
  jitter_ms: number | null;
  status_code: number | null;
  cert_days: number | null;
  answer?: string | null;
  error: string | null;
}

export const CHECKS_KEY = ["checks"];

export function useChecks() {
  const { refetchInterval } = useRefresh();
  return useQuery({
    queryKey: CHECKS_KEY,
    queryFn: () => get<Check[]>("/api/checks"),
    refetchInterval,
  });
}

/** Gotowe sprawdzenia do jednego kliknięcia: jakość łącza (ping do publicznych DNS) i brama. */
export const CHECK_PRESETS: CheckPreset[] = [
  {
    id: "google",
    payload: {
      name: "Internet – Google DNS",
      kind: "ping",
      target: "8.8.8.8",
      port: null,
      interval_s: 30,
      timeout_s: 3,
      expect_status: null,
      keyword: null,
      verify_tls: true,
    },
  },
  {
    id: "cloudflare",
    payload: {
      name: "Internet – Cloudflare DNS",
      kind: "ping",
      target: "1.1.1.1",
      port: null,
      interval_s: 30,
      timeout_s: 3,
      expect_status: null,
      keyword: null,
      verify_tls: true,
    },
  },
  {
    id: "web",
    payload: {
      name: "Strona WWW",
      kind: "http",
      target: "https://www.google.com",
      port: null,
      interval_s: 60,
      timeout_s: 10,
      expect_status: null,
      keyword: null,
      verify_tls: true,
    },
  },
];

export interface CheckPreset {
  id: string;
  payload: Omit<CheckPayload, "enabled">;
}

/** Gotowe sprawdzenia do zaproponowania: ping do bramy każdego routera w NetPulse (sieć domowa – „u mnie czy
 * u dostawcy?”), potem stałe. Bez tych, których cel już jest sprawdzany. */
export function checkPresets(devices: Pick<Device, "id" | "name" | "host" | "kind" | "enabled">[], existing: Pick<Check, "kind" | "target">[]): CheckPreset[] {
  const gateways: CheckPreset[] = devices
    .filter((d) => d.kind === "gateway" && d.enabled)
    .map((d) => ({
      id: `gateway-${d.id}`,
      payload: { name: `Brama – ${d.name}`, kind: "ping", target: d.host, port: null, interval_s: 30, timeout_s: 3, expect_status: null, keyword: null, verify_tls: true },
    }));
  const taken = new Set(existing.map((c) => `${c.kind} ${c.target.toLowerCase()}`));
  return [...gateways, ...CHECK_PRESETS].filter((p) => !taken.has(`${p.payload.kind} ${p.payload.target.toLowerCase()}`));
}

/** Cel w jednej linii: host, host:port, adres URL albo „A example.com @ 8.8.8.8”. */
export function checkTarget(c: Pick<Check, "kind" | "target" | "port" | "dns_type" | "dns_server">): string {
  if (c.kind === "dns") {
    const server = c.dns_server ? ` @ ${c.dns_server}${c.port && c.port !== 53 ? `:${c.port}` : ""}` : "";
    return `${c.dns_type ?? "A"} ${c.target}${server}`;
  }
  return c.kind === "tcp" && c.port ? `${c.target}:${c.port}` : c.target;
}
