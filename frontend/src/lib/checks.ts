/** Sprawdzanie dostępności: ping, HTTP(S), port TCP (API: backend/netpulse/api/checks.py). */
import { useQuery } from "@tanstack/react-query";
import { get } from "./api";
import { useRefresh } from "./refresh";

export type CheckKind = "ping" | "http" | "tcp";
export const CHECK_KINDS: CheckKind[] = ["ping", "http", "tcp"];
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
}

export interface Check extends CheckPayload {
  id: number;
  status: "up" | "down" | "unknown" | string;
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
}

export interface CheckTestResult {
  up: boolean;
  latency_ms: number | null;
  loss_percent: number | null;
  jitter_ms: number | null;
  status_code: number | null;
  cert_days: number | null;
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
export const CHECK_PRESETS: {
  id: string;
  payload: Omit<CheckPayload, "enabled">;
}[] = [
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

/** Cel w jednej linii: host, host:port albo adres URL. */
export function checkTarget(c: Pick<Check, "kind" | "target" | "port">): string {
  return c.kind === "tcp" && c.port ? `${c.target}:${c.port}` : c.target;
}
