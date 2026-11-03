/**
 * Widgety przeglądu (od 0.42.0, wariant A): pasek stanu sieci, ostatnie alerty i paski dostępności sprawdzeń.
 * Alertów nie ma na pulpicie publicznym – tam pasek stanu pokazuje tylko urządzenia.
 */
import { IconAlertTriangle, IconCheck, IconX } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { t } from "../../i18n";
import { ALERTS_KEY, useAlertSummary, type Alert, type Severity } from "../../lib/alerts";
import { get, type SeriesPoint } from "../../lib/api";
import { relativeTime } from "../../lib/format";
import type { AlertsLimit, ChecksDays } from "../../lib/layout";
import { useCollection, type CollectionRow } from "../../lib/panels";
import { useDetailLinks } from "../../lib/publicMode";
import { useDashboardSummary } from "../../lib/queries";
import { useRefresh } from "../../lib/refresh";
import { Card, ErrorNote } from "../ui";

/** Odmiana liczebnika: 1 ostrzeżenie, 2 ostrzeżenia, 5 ostrzeżeń. */
export function plural(n: number, one: string, few: string, many: string): string {
  if (n === 1) return one;
  const tens = n % 100;
  const units = n % 10;
  return units >= 2 && units <= 4 && (tens < 12 || tens > 14) ? few : many;
}

function CardTitle({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 pb-3">
      <h2 className="text-base font-semibold">{title}</h2>
      {children}
    </div>
  );
}

// --- pasek stanu ------------------------------------------------------------------------

type Tone = "success" | "warning" | "danger";

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

const TONE_STYLE: Record<Tone, string> = {
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
};
const TONE_ICON = { success: IconCheck, warning: IconAlertTriangle, danger: IconX };

export function StatusWidget() {
  const linked = useDetailLinks();
  const summary = useDashboardSummary();
  const alerts = useAlertSummary(linked);
  const s = summary.data;
  if (!s) return summary.isError ? <ErrorNote>{t("dash.error")}</ErrorNote> : null;
  const { tone, title, parts } = networkStatus(s.devices, linked ? (alerts.data ?? null) : null);
  const Icon = TONE_ICON[tone];
  const read = relativeTime(new Date(summary.dataUpdatedAt).toISOString());
  if (read) parts.push(t("status.read", { when: read }));
  const firing = alerts.data?.firing ?? 0;
  return (
    <Card className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
      <span className={`flex size-9 shrink-0 items-center justify-center rounded-full ${TONE_STYLE[tone]}`}>
        <Icon size={18} stroke={2.2} aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-[1_1_280px]">
        <p className="text-[15px] font-semibold">{title}</p>
        <p className="text-[13px] text-muted">{parts.join(" · ")}</p>
      </div>
      {linked && firing > 0 && (
        <Link to="/alerts" className="text-[13px] font-medium text-text-2 hover:text-text">
          {t("status.showAlerts")} →
        </Link>
      )}
    </Card>
  );
}

// --- ostatnie alerty ----------------------------------------------------------------------

const SEVERITY_DOT: Record<Severity, string> = { critical: "bg-danger", warning: "bg-warning", info: "bg-muted" };

/** Aktywne na górze, potem najnowsze. */
export function sortAlerts(list: Alert[]): Alert[] {
  return [...list].sort((a, b) => (a.state === b.state ? b.started_at.localeCompare(a.started_at) : a.state === "firing" ? -1 : 1));
}

/** Aktywne mają pierwszeństwo nawet wtedy, gdy są starsze od świeżo rozwiązanych – resztę miejsc dopełniają rozwiązane. */
export function recentAlerts(firing: Alert[], resolved: Alert[], limit: number): Alert[] {
  return sortAlerts([...firing, ...resolved]).slice(0, limit);
}

export function AlertsWidget({ limit }: { limit: AlertsLimit }) {
  const linked = useDetailLinks();
  const { refetchInterval } = useRefresh();
  const query = (state: "firing" | "resolved") => ({
    queryKey: [...ALERTS_KEY, "recent", state, limit],
    queryFn: () => get<Alert[]>(`/api/alerts?state=${state}&limit=${limit}`),
    refetchInterval,
    enabled: linked,
    retry: false,
  });
  const firingQ = useQuery(query("firing"));
  const resolvedQ = useQuery(query("resolved"));
  const isError = firingQ.isError || resolvedQ.isError;
  const data = firingQ.data && resolvedQ.data ? recentAlerts(firingQ.data, resolvedQ.data, limit) : undefined;
  if (!linked) {
    return (
      <Card className="flex flex-col p-5">
        <CardTitle title={t("widget.type.alerts")} />
        <p className="text-sm text-muted">{t("alertsWidget.public")}</p>
      </Card>
    );
  }
  const list = data ?? [];
  const firing = firingQ.data?.length ?? 0;
  return (
    <Card className="flex flex-col p-5">
      <CardTitle title={t("widget.type.alerts")}>
        {firing > 0 && (
          <span className="rounded-full border border-warning/30 bg-warning-soft px-2.5 py-0.5 text-xs font-semibold text-warning">
            {t("alertsWidget.active", { n: firing >= limit ? `${limit}+` : firing })}
          </span>
        )}
      </CardTitle>
      {isError && <ErrorNote>{t("dash.error")}</ErrorNote>}
      {data && list.length === 0 && <p className="text-sm text-muted">{t("alertsWidget.none")}</p>}
      <ul className="flex flex-col">
        {list.map((a) => {
          const when = relativeTime(a.state === "firing" ? a.started_at : (a.resolved_at ?? a.started_at));
          return (
            <li key={a.id} className="flex gap-3 border-t border-border/60 py-3 first:border-t-0 first:pt-0">
              <span className={`mt-1.5 size-2 shrink-0 rounded-full ${a.state === "firing" ? SEVERITY_DOT[a.severity] : "bg-border-strong"}`} aria-hidden="true" />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium" title={a.title}>
                  {a.title}
                </p>
                <p className="text-xs text-muted">
                  {[a.state === "firing" ? t(`alerts.severity.${a.severity}`) : t("alertsWidget.resolved"), when].filter(Boolean).join(" · ")}
                </p>
              </div>
            </li>
          );
        })}
      </ul>
      <Link to="/alerts" className="mt-auto pt-3 text-[13px] font-medium text-text-2 hover:text-text">
        {t("alertsWidget.history")} →
      </Link>
    </Card>
  );
}

// --- dostępność sprawdzeń ------------------------------------------------------------------

export interface DayBar {
  day: string;
  /** Średnia dostępność dnia w %, null = brak pomiarów */
  value: number | null;
}

const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Punkty sprawdzenia → paski dzień po dniu (czas lokalny), od najstarszego. Czysta funkcja (testy). */
export function dailyBars(points: SeriesPoint[], days: number, now: Date = new Date()): DayBar[] {
  const sums = new Map<string, { sum: number; n: number }>();
  for (const p of points) {
    const v = p.values.availability_percent;
    if (v == null) continue;
    const key = dayKey(new Date(p.time));
    const acc = sums.get(key) ?? { sum: 0, n: 0 };
    sums.set(key, { sum: acc.sum + v, n: acc.n + 1 });
  }
  return Array.from({ length: days }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1 - i));
    const acc = sums.get(dayKey(d));
    return { day: dayKey(d), value: acc ? acc.sum / acc.n : null };
  });
}

function barClass(v: number | null): string {
  if (v == null) return "bg-surface-2";
  if (v >= 99.9) return "bg-muted/45";
  return v >= 95 ? "bg-warning" : "bg-danger";
}

const pct = (v: number) => `${v.toLocaleString("pl-PL", { maximumFractionDigits: v >= 99.9 && v < 100 ? 2 : 1 })} %`;

function CheckRow({ row, days }: { row: CollectionRow; days: ChecksDays }) {
  const { refetchInterval } = useRefresh();
  const minutes = days * 1440;
  const { data } = useQuery({
    queryKey: ["check-days", row.key, days],
    queryFn: () => get<SeriesPoint[]>(`/api/checks/${row.key}/metrics?minutes=${minutes}`),
    refetchInterval,
    retry: false,
  });
  const bars = dailyBars(data ?? [], days);
  const known = bars.filter((b) => b.value != null);
  const avg = known.length ? known.reduce((s, b) => s + (b.value ?? 0), 0) / known.length : null;
  const latency = row.values.latency_ms;
  const up = row.values.up;
  return (
    <li className="flex flex-col gap-2 border-t border-border/60 py-3 first:border-t-0 first:pt-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{row.label}</p>
          <p className="text-xs text-muted">{avg != null ? t("checksWidget.avg", { value: pct(avg), days }) : t("checksWidget.noData")}</p>
        </div>
        <span className={`shrink-0 text-sm font-semibold ${up === 0 ? "text-danger" : ""}`}>
          {up === 0 ? t("dash.status.down") : latency != null ? `${Math.round(latency)} ms` : up === 1 ? t("dash.status.up") : "–"}
        </span>
      </div>
      <div className="flex gap-0.5" role="img" aria-label={t("checksWidget.bars", { days })}>
        {bars.map((b) => (
          <span key={b.day} title={`${b.day}: ${b.value == null ? t("checksWidget.noData") : pct(b.value)}`} className={`h-5 flex-1 rounded-sm ${barClass(b.value)}`} />
        ))}
      </div>
    </li>
  );
}

export function ChecksWidget({ days }: { days: ChecksDays }) {
  const linked = useDetailLinks();
  const { data, isError } = useCollection({ kind: "checks" });
  return (
    <Card className="flex flex-col p-5">
      <CardTitle title={t("widget.type.checks")}>
        <span className="text-xs text-muted">{t("checksWidget.period", { days })}</span>
      </CardTitle>
      {isError && <ErrorNote>{t("dash.error")}</ErrorNote>}
      {data && data.length === 0 && (
        <p className="text-sm text-muted">
          {t("checksWidget.none")}{" "}
          {linked && (
            <Link to="/checks" className="font-medium text-text-2 underline hover:text-text">
              {t("checksWidget.add")}
            </Link>
          )}
        </p>
      )}
      <ul className="flex flex-col">
        {(data ?? []).map((row) => (
          <CheckRow key={row.key} row={row} days={days} />
        ))}
      </ul>
    </Card>
  );
}
