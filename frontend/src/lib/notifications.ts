/** Kanały powiadomień o alertach (API: backend/netpulse/api/notifications.py). */
import { useQuery } from "@tanstack/react-query";
import { get } from "./api";
import type { Severity } from "./alerts";

export type ChannelKind = "webhook" | "ntfy" | "email";
export const CHANNEL_KINDS: ChannelKind[] = ["webhook", "ntfy", "email"];

/** Serwer SMTP kanału e-mail (hasło jest osobno i nigdy nie wraca z serwera). */
export interface EmailConfig {
  host: string;
  port: number;
  security: "starttls" | "ssl" | "none";
  username: string | null;
  sender: string | null;
  recipients: string[];
}

export interface NotificationChannel {
  id: number;
  name: string;
  kind: ChannelKind;
  /** Sam host adresu (webhook, ntfy) albo serwer SMTP: ścieżka i tokeny nigdy nie wracają z serwera */
  url_hint: string;
  /** Zapisany token ntfy albo hasło SMTP */
  has_secret: boolean;
  email: EmailConfig | null;
  enabled: boolean;
  min_severity: Severity;
  notify_resolved: boolean;
  /** Ciche godziny „GG:MM” w strefie serwera (`timezone`); null = bez ciszy */
  quiet_from: string | null;
  quiet_to: string | null;
  /** W ciszy przechodzą alerty krytyczne */
  quiet_critical: boolean;
  /** Alerty czekające na koniec cichych godzin */
  quiet_pending: number;
  timezone: string;
  last_status: "ok" | "error" | null;
  last_error: string | null;
  last_sent_at: string | null;
  created_at: string;
}

export interface ChannelTestResult {
  ok: boolean;
  error: string | null;
}

export const CHANNELS_KEY = ["notification-channels"] as const;

export function useChannels() {
  return useQuery({ queryKey: CHANNELS_KEY, queryFn: () => get<NotificationChannel[]>("/api/notification-channels") });
}

/** Adres webhooka: musi zaczynać się od http:// albo https:// i mieć host (zgodnie z walidacją serwera). */
export function isValidWebhookUrl(value: string): boolean {
  try {
    const u = new URL(value.trim());
    return (u.protocol === "http:" || u.protocol === "https:") && u.host !== "";
  } catch {
    return false;
  }
}

/** Adres tematu ntfy: http(s) z hostem i nazwą tematu w ścieżce (np. https://ntfy.sh/moj-temat). */
export function isValidNtfyUrl(value: string): boolean {
  if (!isValidWebhookUrl(value)) return false;
  return new URL(value.trim()).pathname.replace(/\/+$/, "").length > 1;
}

export function isValidEmail(value: string): boolean {
  return /^[^@\s,]+@[^@\s,]+$/.test(value.trim());
}

/** Lista adresatów z pola tekstowego: po przecinku, średniku albo spacji. */
export function parseRecipients(value: string): string[] {
  return value
    .split(/[,;\s]+/)
    .map((r) => r.trim())
    .filter(Boolean);
}
