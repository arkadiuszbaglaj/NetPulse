import { IconChartLine, IconPencil, IconPlus, IconTrash } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Dialog } from "../components/Dialog";
import { Button, Card, ErrorNote, Field, PageHeader, Select, SuccessNote, Toggle } from "../components/ui";
import { ChartWidget } from "../components/widgets/ChartWidget";
import { t, type TextKey } from "../i18n";
import { ApiError, del, post, request } from "../lib/api";
import {
  CHECK_INTERVALS,
  CHECK_KINDS,
  checkPresets,
  CHECKS_KEY,
  checkTarget,
  useChecks,
  type Check,
  type CheckKind,
  type CheckPayload,
  type CheckTestResult,
} from "../lib/checks";
import { relativeTime } from "../lib/format";
import { useDevices } from "../lib/queries";
import { newChartConfig, type ChartConfig } from "../lib/layout";

const STATUS_STYLE: Record<string, string> = {
  up: "bg-success-soft text-success",
  down: "bg-danger-soft text-danger",
  unknown: "bg-surface-2 text-text-2",
};
const STATUS_LABEL: Record<string, TextKey> = {
  up: "chk.status.up",
  down: "chk.status.down",
  unknown: "chk.status.unknown",
};
const KIND_LABEL: Record<CheckKind, TextKey> = {
  ping: "chk.kind.ping",
  http: "chk.kind.http",
  tcp: "chk.kind.tcp",
};
const errorMessage = (err: unknown) => (err instanceof ApiError ? err.message : t("auth.error.generic"));
const iconButton = "flex size-9 items-center justify-center rounded-lg text-text-2 hover:bg-surface-2 hover:text-text disabled:opacity-50";
const num = (v: number, digits = 1) => new Intl.NumberFormat("pl", { maximumFractionDigits: digits }).format(v);
/** Odstęp między sprawdzeniami: „30 s”, „5 min”, „1 godz.”. */
export const formatInterval = (s: number) => (s < 60 ? `${s} s` : s < 3600 ? `${num(s / 60)} min` : `${num(s / 3600)} godz.`);
const ms = (v: number | null) => (v == null ? "–" : `${num(v, v < 10 ? 1 : 0)} ms`);

interface FormValues {
  name: string;
  kind: CheckKind;
  target: string;
  port: string;
  interval_s: number;
  timeout_s: string;
  expect_status: string;
  keyword: string;
  verify_tls: boolean;
  enabled: boolean;
}

const toValues = (c?: Partial<CheckPayload>): FormValues => ({
  name: c?.name ?? "",
  kind: c?.kind ?? "ping",
  target: c?.target ?? "",
  port: c?.port != null ? String(c.port) : "",
  interval_s: c?.interval_s ?? 60,
  timeout_s: String(c?.timeout_s ?? 5),
  expect_status: c?.expect_status ?? "",
  keyword: c?.keyword ?? "",
  verify_tls: c?.verify_tls ?? true,
  enabled: c?.enabled ?? true,
});

/** Wynik sprawdzenia w jednej linii: opóźnienie, utrata, jitter, kod HTTP, certyfikat. */
export function resultParts(r: {
  latency_ms: number | null;
  loss_percent: number | null;
  jitter_ms: number | null;
  status_code: number | null;
  cert_days: number | null;
}): string[] {
  return [
    r.latency_ms != null ? t("chk.latency", { v: ms(r.latency_ms) }) : null,
    r.loss_percent != null ? t("chk.loss", { v: num(r.loss_percent) }) : null,
    r.jitter_ms != null ? t("chk.jitter", { v: ms(r.jitter_ms) }) : null,
    r.status_code != null ? t("chk.code", { v: r.status_code }) : null,
    r.cert_days != null ? t("chk.cert", { v: num(r.cert_days, 0) }) : null,
  ].filter((x): x is string => x != null);
}

function TestResult({ result }: { result: CheckTestResult }) {
  const parts = resultParts(result).join(" · ");
  return result.up ? <SuccessNote>{t("chk.test.ok", { details: parts || "–" })}</SuccessNote> : <ErrorNote>{result.error ?? t("chk.status.down")}</ErrorNote>;
}

function CheckForm({ check, preset, onClose }: { check?: Check; preset?: Partial<CheckPayload>; onClose: () => void }) {
  const qc = useQueryClient();
  const [values, setValues] = useState<FormValues>(toValues(check ?? preset));
  const [errors, setErrors] = useState<Partial<Record<keyof FormValues, string>>>({});
  const set = <K extends keyof FormValues>(key: K, value: FormValues[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
  };
  const payload = (): CheckPayload => ({
    name: values.name.trim(),
    kind: values.kind,
    target: values.target.trim(),
    port: values.kind === "tcp" ? Number(values.port) : null,
    interval_s: values.interval_s,
    timeout_s: Number(values.timeout_s.replace(",", ".")),
    enabled: values.enabled,
    expect_status: values.kind === "http" && values.expect_status.trim() ? values.expect_status.trim() : null,
    keyword: values.kind === "http" && values.keyword.trim() ? values.keyword.trim() : null,
    verify_tls: values.verify_tls,
  });

  function validate(): boolean {
    const found: typeof errors = {};
    if (!values.name.trim()) found.name = t("chk.err.name");
    const target = values.target.trim();
    if (!target) found.target = t("chk.err.target");
    else if (values.kind === "http" && !/^https?:\/\/[^/\s]+/i.test(target)) found.target = t("chk.err.url");
    if (values.kind === "tcp") {
      const port = Number(values.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) found.port = t("ctrl.err.port");
    }
    const timeout = Number(values.timeout_s.replace(",", "."));
    if (!Number.isFinite(timeout) || timeout < 1 || timeout > 30) found.timeout_s = t("chk.err.timeout");
    else if (timeout >= values.interval_s) found.timeout_s = t("chk.err.timeoutInterval");
    setErrors(found);
    return Object.keys(found).length === 0;
  }

  const test = useMutation({
    mutationFn: () => post<CheckTestResult>("/api/checks/test", payload()),
  });
  const save = useMutation({
    mutationFn: () => (check ? request<Check>("PUT", `/api/checks/${check.id}`, payload()) : post<Check>("/api/checks", payload())),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: CHECKS_KEY });
      onClose();
    },
  });
  const busy = test.isPending || save.isPending;
  const targetHint: TextKey = values.kind === "http" ? "chk.target.hint.http" : values.kind === "tcp" ? "chk.target.hint.tcp" : "chk.target.hint.ping";

  return (
    <Dialog
      title={check ? t("chk.form.edit", { name: check.name }) : t("chk.form.add")}
      onClose={onClose}
      footer={
        <>
          <Button className="mr-auto" disabled={busy} onClick={() => validate() && test.mutate()}>
            {test.isPending ? t("devices.testing") : t("chk.test")}
          </Button>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" disabled={busy} onClick={() => validate() && save.mutate()}>
            {save.isPending ? t("common.saving") : t("common.save")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field
          id="chk-name"
          label={t("chk.name")}
          value={values.name}
          error={errors.name}
          maxLength={80}
          placeholder="Internet"
          onChange={(e) => set("name", e.target.value)}
        />
        <Select id="chk-kind" label={t("chk.kind")} value={values.kind} onChange={(e) => set("kind", e.target.value as CheckKind)}>
          {CHECK_KINDS.map((k) => (
            <option key={k} value={k}>
              {t(KIND_LABEL[k])}
            </option>
          ))}
        </Select>
        <div className={`grid gap-4 ${values.kind === "tcp" ? "sm:grid-cols-[1fr_8rem]" : ""}`}>
          <Field
            id="chk-target"
            label={t(values.kind === "http" ? "chk.url" : "devform.host")}
            value={values.target}
            error={errors.target}
            hint={t(targetHint)}
            placeholder={values.kind === "http" ? "https://example.com" : "8.8.8.8"}
            autoCapitalize="none"
            spellCheck={false}
            onChange={(e) => set("target", e.target.value)}
          />
          {values.kind === "tcp" && (
            <Field
              id="chk-port"
              label={t("chk.port")}
              inputMode="numeric"
              value={values.port}
              error={errors.port}
              placeholder="443"
              onChange={(e) => set("port", e.target.value)}
            />
          )}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Select id="chk-interval" label={t("chk.interval")} value={values.interval_s} onChange={(e) => set("interval_s", Number(e.target.value))}>
            {CHECK_INTERVALS.map((s) => (
              <option key={s} value={s}>
                {formatInterval(s)}
              </option>
            ))}
          </Select>
          <Field
            id="chk-timeout"
            label={t("chk.timeout")}
            inputMode="decimal"
            value={values.timeout_s}
            error={errors.timeout_s}
            onChange={(e) => set("timeout_s", e.target.value)}
          />
        </div>
        {values.kind === "http" && (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                id="chk-expect"
                label={t("chk.expect")}
                value={values.expect_status}
                hint={t("chk.expect.hint")}
                placeholder="200-399"
                maxLength={32}
                onChange={(e) => set("expect_status", e.target.value)}
              />
              <Field
                id="chk-keyword"
                label={t("chk.keyword")}
                value={values.keyword}
                hint={t("chk.keyword.hint")}
                maxLength={255}
                onChange={(e) => set("keyword", e.target.value)}
              />
            </div>
            <label htmlFor="chk-tls" className="flex items-start gap-2 text-sm">
              <input
                id="chk-tls"
                type="checkbox"
                checked={values.verify_tls}
                onChange={(e) => set("verify_tls", e.target.checked)}
                className="mt-0.5 size-4 accent-accent"
              />
              <span>
                {t("ctrl.tls")}
                <span className="block text-xs text-muted">{t("chk.tls.hint")}</span>
              </span>
            </label>
          </>
        )}
        {values.kind === "ping" && <p className="text-xs text-text-2">{t("chk.ping.hint")}</p>}
        {test.isSuccess && <TestResult result={test.data} />}
        {test.isError && <ErrorNote>{errorMessage(test.error)}</ErrorNote>}
        {save.isError && <ErrorNote>{errorMessage(save.error)}</ErrorNote>}
      </div>
    </Dialog>
  );
}

/** Wykres sprawdzenia: opóźnienie (i jitter) na lewej osi, utrata pakietów albo dostępność na prawej. */
export function checkChart(check: Pick<Check, "id" | "kind" | "name">): ChartConfig {
  const series =
    check.kind === "ping"
      ? [
          { key: "latency_ms", color: 1 as const },
          { key: "jitter_ms", color: 3 as const },
          { key: "loss_percent", color: 5 as const, axis: "right" as const },
        ]
      : [
          { key: "latency_ms", color: 1 as const },
          {
            key: "availability_percent",
            color: 2 as const,
            axis: "right" as const,
          },
        ];
  const cfg = newChartConfig({ kind: "check", id: check.id }, series);
  return {
    ...cfg,
    title: check.name,
    chart: "line",
    axes: { left: {}, right: { min: 0, max: 100 } },
    legend: {
      mode: "table",
      placement: "bottom",
      values: ["last", "avg", "max"],
    },
  };
}

function CheckRow({
  check,
  open,
  onToggleChart,
  onEdit,
  onDelete,
}: {
  check: Check;
  open: boolean;
  onToggleChart: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const qc = useQueryClient();
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => {
      const { name, kind, target, port, interval_s, timeout_s, expect_status, keyword, verify_tls } = check;
      return request<Check>("PUT", `/api/checks/${check.id}`, {
        name,
        kind,
        target,
        port,
        interval_s,
        timeout_s,
        expect_status,
        keyword,
        verify_tls,
        enabled,
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: CHECKS_KEY }),
  });
  const status = check.enabled ? (check.status in STATUS_STYLE ? check.status : "unknown") : null;
  const since = check.status_since ? relativeTime(check.status_since) : null;
  const metrics = resultParts({ ...check, latency_ms: check.last_latency_ms });

  return (
    <li className={`flex flex-col gap-2 px-4 py-3 ${check.enabled ? "" : "opacity-70"}`}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-56">
          <p className="truncate text-sm font-medium">{check.name}</p>
          <p className="truncate text-xs text-text-2">
            {t(KIND_LABEL[check.kind as CheckKind] ?? "chk.kind.ping")} · {checkTarget(check)} · {t("chk.every", { v: formatInterval(check.interval_s) })}
          </p>
          {metrics.length > 0 && <p className="truncate text-xs text-text-2">{metrics.join(" · ")}</p>}
        </div>
        {check.availability_24h != null && (
          <span className="text-xs text-text-2" title={t("chk.availability.hint")}>
            {t("chk.availability", { v: num(check.availability_24h, 2) })}
          </span>
        )}
        {status ? (
          <span className={`rounded-md px-2 py-0.5 text-xs ${STATUS_STYLE[status]}`} title={since ?? undefined}>
            {t(STATUS_LABEL[status])}
          </span>
        ) : (
          <span className="rounded-md bg-surface-2 px-2 py-0.5 text-xs text-text-2">{t("devices.disabled")}</span>
        )}
        <div className="flex items-center gap-1">
          <Toggle checked={check.enabled} disabled={toggle.isPending} label={`${t("devices.enabled")}: ${check.name}`} onChange={(v) => toggle.mutate(v)} />
          <button
            type="button"
            className={iconButton}
            aria-label={`${t("chk.chart")} ${check.name}`}
            aria-pressed={open}
            title={t("chk.chart")}
            onClick={onToggleChart}
          >
            <IconChartLine size={18} aria-hidden="true" />
          </button>
          <button type="button" className={iconButton} aria-label={`${t("common.edit")} ${check.name}`} title={t("common.edit")} onClick={onEdit}>
            <IconPencil size={18} aria-hidden="true" />
          </button>
          <button type="button" className={iconButton} aria-label={`${t("common.delete")} ${check.name}`} title={t("common.delete")} onClick={onDelete}>
            <IconTrash size={18} aria-hidden="true" />
          </button>
        </div>
      </div>
      {check.enabled && check.status === "down" && check.last_error && <ErrorNote>{check.last_error}</ErrorNote>}
      {open && <ChartWidget config={checkChart(check)} />}
    </li>
  );
}

/** Dostępność: ping (jakość łącza), HTTP(S) i porty TCP – lista, wykresy, dodawanie i edycja. */
export function ChecksPage() {
  const qc = useQueryClient();
  const { data, isLoading, isError } = useChecks();
  const [form, setForm] = useState<{
    check?: Check;
    preset?: Partial<CheckPayload>;
  } | null>(null);
  const [toDelete, setToDelete] = useState<Check | null>(null);
  const [chartFor, setChartFor] = useState<number | null>(null);
  const remove = useMutation({
    mutationFn: (id: number) => del(`/api/checks/${id}`),
    onSuccess: async () => {
      setToDelete(null);
      await qc.invalidateQueries({ queryKey: CHECKS_KEY });
    },
  });
  const list = data ?? [];
  const down = list.filter((c) => c.enabled && c.status === "down").length;
  const devices = useDevices().data ?? [];
  const presets = checkPresets(devices, list);
  const presetButtons = presets.map((p) => (
    <Button key={p.id} onClick={() => setForm({ preset: p.payload })}>
      <IconPlus size={16} aria-hidden="true" />
      {p.payload.name}
    </Button>
  ));

  return (
    <>
      <PageHeader title={t("chk.title")}>
        <Button variant="primary" onClick={() => setForm({})}>
          <IconPlus size={18} aria-hidden="true" />
          {t("chk.add")}
        </Button>
      </PageHeader>
      <p className="mb-4 max-w-prose text-sm text-text-2">{t("chk.intro")}</p>

      {isError && !data && <ErrorNote>{t("chk.loadError")}</ErrorNote>}
      {!isLoading && !isError && list.length === 0 && (
        <Card className="p-6">
          <h2 className="text-base font-medium">{t("chk.empty.title")}</h2>
          <p className="mt-1 max-w-prose text-sm text-text-2">{t("chk.empty.body")}</p>
          <div className="mt-4 flex flex-wrap gap-2">{presetButtons}</div>
        </Card>
      )}
      {list.length > 0 && presets.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="text-sm text-text-2">{t("chk.quick")}</span>
          {presetButtons}
        </div>
      )}
      {list.length > 0 && (
        <>
          <p className="mb-2 text-sm text-text-2">
            {down > 0 ? t("chk.summary.down", { down, total: list.length }) : t("chk.summary.ok", { total: list.length })}
          </p>
          <Card>
            <ul className="divide-y divide-border">
              {list.map((c) => (
                <CheckRow
                  key={c.id}
                  check={c}
                  open={chartFor === c.id}
                  onToggleChart={() => setChartFor((v) => (v === c.id ? null : c.id))}
                  onEdit={() => setForm({ check: c })}
                  onDelete={() => {
                    remove.reset();
                    setToDelete(c);
                  }}
                />
              ))}
            </ul>
          </Card>
        </>
      )}

      {form && <CheckForm check={form.check} preset={form.preset} onClose={() => setForm(null)} />}
      {toDelete && (
        <Dialog
          size="sm"
          title={t("chk.delete.title")}
          onClose={() => setToDelete(null)}
          footer={
            <>
              <Button data-autofocus onClick={() => setToDelete(null)}>
                {t("common.cancel")}
              </Button>
              <Button variant="danger" disabled={remove.isPending} onClick={() => remove.mutate(toDelete.id)}>
                {remove.isPending ? t("devices.delete.busy") : t("common.delete")}
              </Button>
            </>
          }
        >
          <p className="text-sm">{t("chk.delete.body", { name: toDelete.name })}</p>
          {remove.isError && (
            <div className="mt-3">
              <ErrorNote>{errorMessage(remove.error)}</ErrorNote>
            </div>
          )}
        </Dialog>
      )}
    </>
  );
}
