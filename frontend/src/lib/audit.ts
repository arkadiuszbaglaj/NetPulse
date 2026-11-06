/** Konta i dziennik zdarzeń (od 0.61.0, backend: api/users.py, audit.py). */
import { useQuery } from "@tanstack/react-query";
import { get, type User } from "./api";

export const USERS_KEY = ["users"] as const;
export const AUDIT_KEY = ["audit"] as const;

export type AuditKind = "all" | "auth" | "changes" | "denied";

export interface AuditEntry {
  id: number;
  time: string;
  user_id: number | null;
  username: string | null;
  ip: string | null;
  action: string;
  target: string | null;
  status: number | null;
  detail: string | null;
}

export interface AuditPage {
  items: AuditEntry[];
  total: number;
}

export const useUsers = () => useQuery({ queryKey: USERS_KEY, queryFn: () => get<User[]>("/api/users") });

export function useAudit(kind: AuditKind, q: string, offset: number, limit = 50) {
  const params = new URLSearchParams({ kind, limit: String(limit), offset: String(offset) });
  if (q.trim()) params.set("q", q.trim());
  return useQuery({
    queryKey: [...AUDIT_KEY, kind, q.trim(), offset, limit],
    queryFn: () => get<AuditPage>(`/api/audit?${params}`),
    placeholderData: (prev) => prev,
  });
}

const AUTH_LABEL: Record<string, string> = {
  setup: "Założenie pierwszego konta",
  login: "Logowanie",
  login_failed: "Nieudane logowanie",
  logout: "Wylogowanie",
  password: "Zmiana własnego hasła",
  totp_enable: "Włączenie logowania dwuskładnikowego",
  totp_disable: "Wyłączenie logowania dwuskładnikowego",
  totp_recovery: "Nowe kody zapasowe 2FA",
};

/** Zasób z pierwszego członu ścieżki API (szablon trasy, np. /api/devices/{device_id}). */
const RESOURCE: Record<string, string> = {
  devices: "urządzenie",
  interfaces: "port",
  "alert-rules": "reguła alertu",
  alerts: "alert",
  maintenance: "okno serwisowe",
  users: "konto",
  dashboards: "pulpit",
  dashboard: "pulpit",
  checks: "sprawdzenie dostępności",
  controllers: "kontroler UniFi",
  "notification-channels": "kanał powiadomień",
  backups: "kopia zapasowa",
  modules: "moduły",
  updates: "aktualizacja",
  wan: "łącza WAN",
  agents: "agent",
  proxmox: "Proxmox",
  preferences: "ustawienia odświeżania",
  system: "system",
  probe: "test SNMP",
};

const VERB: Record<string, string> = { POST: "Dodanie", PUT: "Zmiana", PATCH: "Zmiana", DELETE: "Usunięcie" };

/** Czytelny opis wpisu: „Usunięcie: urządzenie”, „Potwierdzenie alertu”, „Logowanie”. */
export function auditLabel(action: string): string {
  if (AUTH_LABEL[action]) return AUTH_LABEL[action];
  const [method, path = ""] = action.split(" ", 2);
  const parts = path.replace(/^\/api\//, "").split("/").filter(Boolean);
  const resource = parts[0] === "system" && parts[1] === "tls" ? "adresy certyfikatu HTTPS" : (RESOURCE[parts[0]] ?? parts[0] ?? path);
  const last = parts[parts.length - 1];
  if (last === "ack") return "Potwierdzenie alertu";
  if (last === "probe" || last === "test") return `Test: ${resource}`;
  const verb = VERB[method];
  return verb ? `${verb}: ${resource}` : action;
}

/** Odrzucona albo nieudana operacja (pokazujemy na czerwono). */
export const auditFailed = (e: AuditEntry) => e.action === "login_failed" || (e.status != null && e.status >= 400);
