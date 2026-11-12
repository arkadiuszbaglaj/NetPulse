/** Stan sieci jednym zdaniem – wspólne dla paska stanu na pulpicie i skrótu w menu (czyste funkcje, testy). */
import { t } from "../i18n";

/** Odmiana liczebnika: 1 ostrzeżenie, 2 ostrzeżenia, 5 ostrzeżeń. */
export function plural(n: number, one: string, few: string, many: string): string {
  if (n === 1) return one;
  const tens = n % 100;
  const units = n % 10;
  return units >= 2 && units <= 4 && (tens < 12 || tens > 14) ? few : many;
}

export type Tone = "success" | "warning" | "danger";

/** Stan sieci jednym zdaniem: co nie działa, ile ostrzeżeń, kiedy ostatni odczyt. Czysta funkcja (testy). */
export function networkStatus(
  devices: { total: number; up: number; down: number },
  alerts: { critical: number; warning: number; info: number } | null,
): { tone: Tone; title: string; parts: string[] } {
  const parts = [t("status.devices", { up: devices.up, total: devices.total })];
  const critical = alerts?.critical ?? 0;
  const warning = alerts?.warning ?? 0;
  if (critical) parts.push(`${critical} ${plural(critical, t("status.critical.one"), t("status.critical.few"), t("status.critical.many"))}`);
  if (warning) parts.push(`${warning} ${plural(warning, t("status.warning.one"), t("status.warning.few"), t("status.warning.many"))}`);
  if (devices.down > 0) return { tone: "danger", title: t("status.down", { n: devices.down }), parts };
  if (critical) return { tone: "danger", title: t("status.problems"), parts };
  if (devices.total === 0) return { tone: "warning", title: t("status.empty"), parts: [] };
  return { tone: warning ? "warning" : "success", title: t("status.ok"), parts };
}
