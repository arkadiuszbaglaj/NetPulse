/** Kanały powiadomień o alertach (API: backend/netpulse/api/notifications.py). */
import { useQuery } from "@tanstack/react-query";
import { get } from "./api";
import type { Severity } from "./alerts";

export interface NotificationChannel {
  id: number;
  name: string;
  kind: string;
  /** Sam host adresu webhooka: ścieżka i tokeny nigdy nie wracają z serwera */
  url_hint: string;
  enabled: boolean;
  min_severity: Severity;
  notify_resolved: boolean;
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
