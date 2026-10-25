import {
  IconAlertTriangle,
  IconArrowBackUp,
  IconCircleCheck,
  IconCircleDashed,
  IconCircleX,
  IconDownload,
  IconLoader2,
  IconPlayerSkipForward,
  IconRefresh,
} from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useUser } from "../../auth/AuthProvider";
import { Dialog } from "../../components/Dialog";
import { Button, Card, ErrorNote, PageHeader, Select, Toggle } from "../../components/ui";
import { t, type TextKey } from "../../i18n";
import {
  ApiError,
  UPDATE_CHECK_INTERVALS,
  post,
  type UpdateCheckInterval,
  type UpdateJob,
  type UpdatePhaseStatus,
  type UpdatesResponse,
} from "../../lib/api";
import { formatDateTime, relativeTime } from "../../lib/format";
import { RELOAD_DELAY_MS, reloadPage } from "../../lib/reload";
import { UPDATES_KEY, useSaveUpdateSettings, useUpdateSettings, useUpdates } from "../../lib/updatesApi";
import { UpdateCliHint } from "./UpdateCliHint";

const KEY = UPDATES_KEY;
const VISIBLE_CHANGES = 10;

const PHASE_LABEL: Record<string, TextKey> = {
  prepare: "update.phase.prepare",
  backup: "update.phase.backup",
  fetch: "update.phase.fetch",
  build: "update.phase.build",
  start: "update.phase.start",
  verify: "update.phase.verify",
  rollback: "update.phase.rollback",
};
const STATUS_LABEL: Record<UpdatePhaseStatus, TextKey> = {
  pending: "update.status.pending",
  running: "update.status.running",
  done: "update.status.done",
  failed: "update.status.failed",
  skipped: "update.status.skipped",
};

function PhaseIcon({ status }: { status: UpdatePhaseStatus }) {
  const common = { size: 20, "aria-hidden": true } as const;
  switch (status) {
    case "done":
      return <IconCircleCheck {...common} className="text-success" />;
    case "running":
      return <IconLoader2 {...common} className="animate-spin text-accent" />;
    case "failed":
      return <IconCircleX {...common} className="text-danger" />;
    case "skipped":
      return <IconPlayerSkipForward {...common} className="text-muted" />;
    default:
      return <IconCircleDashed {...common} className="text-muted" />;
  }
}

function errorText(err: unknown): string {
  return err instanceof ApiError ? err.message : t("auth.error.generic");
}

function JobCard({ job, restarting }: { job: UpdateJob; restarting: boolean }) {
  const [details, setDetails] = useState(false);
  const logEnd = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (details && logEnd.current) logEnd.current.scrollTop = logEnd.current.scrollHeight;
  }, [details, job.log.length]);

  const heading = t(`update.job.${job.state === "idle" ? "running" : job.state}` as const);
  const tone =
    job.state === "ok"
      ? "text-success"
      : job.state === "failed"
        ? "text-danger"
        : job.state === "rolled_back"
          ? "text-warning"
          : "text-text";
  const Icon =
    job.state === "ok"
      ? IconCircleCheck
      : job.state === "failed"
        ? IconCircleX
        : job.state === "rolled_back"
          ? IconArrowBackUp
          : IconLoader2;

  return (
    <Card className="mt-4 p-5" aria-live="polite">
      <div className="flex items-start gap-3">
        <Icon size={24} aria-hidden="true" className={`mt-0.5 shrink-0 ${tone} ${job.state === "running" ? "animate-spin" : ""}`} />
        <div className="min-w-0 flex-1">
          <h2 className={`text-base font-medium ${tone}`}>{heading}</h2>
          {job.from_version && (
            <p className="text-sm text-text-2">
              {t("update.job.from", { from: job.from_version, to: job.to_version ?? "…" })}
            </p>
          )}
          {job.started_at && <p className="text-xs text-muted">{t("update.job.started", { when: formatDateTime(job.started_at) })}</p>}
        </div>
      </div>

      {restarting && (
        <p role="status" className="mt-3 rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning">
          {t("update.job.restarting")}
        </p>
      )}

      <ol className="mt-4 flex flex-col gap-2">
        {job.phases.map((p) => (
          <li key={p.id} className="flex items-center gap-2.5 text-sm">
            <PhaseIcon status={p.status} />
            <span className={p.status === "pending" || p.status === "skipped" ? "text-text-2" : ""}>
              {t(PHASE_LABEL[p.id] ?? "update.phase.prepare")}
            </span>
            <span className="ml-auto text-xs text-muted">{t(STATUS_LABEL[p.status])}</span>
          </li>
        ))}
      </ol>

      {job.error && (
        <div className="mt-4">
          <ErrorNote>{job.error}</ErrorNote>
        </div>
      )}
      {job.note && <p className="mt-3 text-sm text-text-2">{job.note}</p>}

      {job.log.length > 0 && (
        <div className="mt-4">
          <button
            type="button"
            aria-expanded={details}
            onClick={() => setDetails((v) => !v)}
            className="text-sm text-accent hover:underline"
          >
            {details ? t("update.job.hideDetails") : t("update.job.details")}
          </button>
          {details && (
            <pre
              ref={logEnd}
              aria-label={t("update.job.log")}
              className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-2 p-3 font-mono text-xs leading-relaxed"
            >
              {job.log.join("\n")}
            </pre>
          )}
        </div>
      )}
    </Card>
  );
}

/** Ustawienia → Aktualizacja: sprawdzanie wersji i instalacja nowej jednym kliknięciem. */
export function UpdatePage() {
  const qc = useQueryClient();
  const user = useUser();
  const [confirming, setConfirming] = useState(false);

  const { data, isError } = useUpdates();
  const autoSettings = useUpdateSettings();
  const saveSettings = useSaveUpdateSettings();

  const check = useMutation({
    mutationFn: () => post<UpdatesResponse>("/api/updates/check"),
    onSuccess: (result) => qc.setQueryData(KEY, result),
  });
  const apply = useMutation({
    mutationFn: () => post<UpdatesResponse>("/api/updates/apply"),
    onSuccess: (result) => {
      qc.setQueryData(KEY, result);
      setConfirming(false);
    },
    onError: () => setConfirming(false),
  });

  const job = data?.job ?? null;
  const running = job?.state === "running";

  // Po zakończonej w tej sesji aktualizacji ładujemy stronę od nowa, żeby użyć nowej wersji panelu
  const wasRunning = useRef(false);
  const [justFinished, setJustFinished] = useState(false);
  useEffect(() => {
    if (running) wasRunning.current = true;
    if (wasRunning.current && job?.state === "ok" && job.to_commit !== job.from_commit) {
      wasRunning.current = false;
      setJustFinished(true);
      const timer = window.setTimeout(reloadPage, RELOAD_DELAY_MS);
      return () => window.clearTimeout(timer);
    }
    if (job && job.state !== "running" && job.state !== "idle") wasRunning.current = false;
  }, [running, job]);

  const info = data?.info ?? null;
  const updater = data?.updater;
  const canUse = updater?.configured && updater.reachable;
  const restarting = running && isError; // API chwilowo nie odpowiada, bo się restartuje
  const checked = info?.checked_at ? relativeTime(info.checked_at) : null;
  const latest = info?.latest.version;

  return (
    <>
      <PageHeader title={t("settings.update.title")} />
      <Card className="max-w-2xl p-5">
        <dl className="flex flex-wrap items-baseline gap-x-8 gap-y-1">
          <div>
            <dt className="text-xs text-text-2">{t("update.installed")}</dt>
            <dd className="text-2xl font-medium">{data ? data.installed_version : "…"}</dd>
          </div>
          {data?.current?.commit && <dd className="font-mono text-xs text-muted">{t("update.commit", { commit: data.current.commit })}</dd>}
        </dl>

        {updater && !canUse && (
          <p role="status" className="mt-4 flex gap-2 rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning">
            <IconAlertTriangle size={18} aria-hidden="true" className="mt-0.5 shrink-0" />
            <span>
              <strong className="font-medium">{t("update.unavailable")}.</strong> {updater.message}
            </span>
          </p>
        )}

        {canUse && (
          <div className="mt-4 border-t border-border pt-4">
            {!info && <p className="text-sm text-text-2">{t("update.neverChecked")}</p>}
            {info && info.update_available && (
              <>
                <p className="flex items-center gap-2 text-sm font-medium text-accent">
                  <IconDownload size={18} aria-hidden="true" />
                  {latest ? t("update.available", { version: latest }) : t("update.availableNoVersion")}
                </p>
                {info.changes.length > 0 && (
                  <section aria-label={t("update.changes")} className="mt-3">
                    <h2 className="text-xs font-medium text-text-2">{t("update.changes")}</h2>
                    <ul className="mt-1.5 flex flex-col gap-1 text-sm">
                      {info.changes.slice(0, VISIBLE_CHANGES).map((c) => (
                        <li key={c.sha} className="flex gap-2">
                          <code className="shrink-0 font-mono text-xs text-muted">{c.sha}</code>
                          <span className="min-w-0">{c.subject}</span>
                        </li>
                      ))}
                    </ul>
                    {info.changes.length > VISIBLE_CHANGES && (
                      <p className="mt-1 text-xs text-muted">{t("update.moreChanges", { count: info.changes.length - VISIBLE_CHANGES })}</p>
                    )}
                  </section>
                )}
              </>
            )}
            {info && !info.update_available && !info.diverged && (
              <p className="flex items-center gap-2 text-sm text-success">
                <IconCircleCheck size={18} aria-hidden="true" />
                {t("update.upToDate")}
              </p>
            )}
            {info?.diverged && <p className="text-sm text-warning">{t("update.diverged")}</p>}
            {checked && <p className="mt-2 text-xs text-muted">{t("update.checkedAt", { when: checked })}</p>}

            <div className="mt-4 flex flex-wrap items-center gap-2">
              {user.is_admin ? (
                <>
                  <Button disabled={check.isPending || running} onClick={() => check.mutate()}>
                    <IconRefresh size={18} aria-hidden="true" className={check.isPending ? "animate-spin" : ""} />
                    {check.isPending ? t("update.checking") : t("update.check")}
                  </Button>
                  {info?.update_available && !running && (
                    <Button variant="primary" disabled={apply.isPending} onClick={() => setConfirming(true)}>
                      {latest ? t("update.apply", { version: latest }) : t("update.applyNoVersion")}
                    </Button>
                  )}
                </>
              ) : (
                <p className="text-sm text-text-2">{t("update.adminOnly")}</p>
              )}
            </div>
            {check.error && (
              <div className="mt-3">
                <ErrorNote>{errorText(check.error)}</ErrorNote>
              </div>
            )}
            {apply.error && (
              <div className="mt-3">
                <ErrorNote>{errorText(apply.error)}</ErrorNote>
              </div>
            )}
          </div>
        )}
      </Card>

      {autoSettings.data && (
        <Card className="mt-4 max-w-2xl p-5">
          <h2 className="text-sm font-medium">{t("update.auto.title")}</h2>
          <div className="mt-3 flex items-center justify-between gap-4">
            <span className="text-sm">{t("update.auto.toggle")}</span>
            <Toggle
              label={t("update.auto.toggle")}
              checked={autoSettings.data.auto_check}
              disabled={!user.is_admin || saveSettings.isPending}
              onChange={(auto_check) => saveSettings.mutate({ ...autoSettings.data, auto_check })}
            />
          </div>
          {autoSettings.data.auto_check && (
            <div className="mt-3 max-w-xs">
              <Select
                id="update-interval"
                label={t("update.auto.interval")}
                value={autoSettings.data.interval_h}
                disabled={!user.is_admin || saveSettings.isPending}
                onChange={(e) =>
                  saveSettings.mutate({ ...autoSettings.data, interval_h: Number(e.target.value) as UpdateCheckInterval })
                }
              >
                {UPDATE_CHECK_INTERVALS.map((h) => (
                  <option key={h} value={h}>
                    {t(`update.auto.every.${h}` as const)}
                  </option>
                ))}
              </Select>
            </div>
          )}
          <p className="mt-3 text-xs text-muted">{t(autoSettings.data.auto_check ? "update.auto.hintOn" : "update.auto.hintOff")}</p>
          {!user.is_admin && <p className="mt-1 text-xs text-muted">{t("update.adminOnly.settings")}</p>}
          {saveSettings.error && (
            <div className="mt-3">
              <ErrorNote>{errorText(saveSettings.error)}</ErrorNote>
            </div>
          )}
        </Card>
      )}

      {job && job.state !== "idle" && (
        <div className="max-w-2xl">
          <JobCard job={job} restarting={restarting} />
          {justFinished && (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button variant="primary" onClick={reloadPage}>
                {t("update.job.reload")}
              </Button>
              <p role="status" className="text-sm text-text-2">
                {t("update.job.reloading")}
              </p>
            </div>
          )}
        </div>
      )}

      {/* Zawsze widoczne – także gdy aktualizacja z panelu jest wyłączona albo usługa nie odpowiada */}
      <div className="mt-4">
        <UpdateCliHint />
      </div>

      {confirming && (
        <Dialog
          size="sm"
          title={t("update.confirm.title")}
          onClose={() => setConfirming(false)}
          footer={
            <>
              <Button data-autofocus onClick={() => setConfirming(false)}>
                {t("common.cancel")}
              </Button>
              <Button variant="primary" disabled={apply.isPending} onClick={() => apply.mutate()}>
                {apply.isPending ? t("update.starting") : t("update.confirm.go")}
              </Button>
            </>
          }
        >
          <p className="text-sm">{t("update.confirm.body")}</p>
          <p className="mt-2 text-sm text-text-2">{t("update.confirm.safety")}</p>
        </Dialog>
      )}
    </>
  );
}
