import { IconPencil, IconPlus, IconTrash } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Dialog } from "../../components/Dialog";
import { Button, Card, ErrorNote, Field, PageHeader, Toggle } from "../../components/ui";
import { t, type TextKey } from "../../i18n";
import { ApiError, del, post, put, type Device } from "../../lib/api";
import { formatDateTime, relativeTime } from "../../lib/format";
import {
  MAINTENANCE_KEY,
  formatMinutes,
  fromLocalInput,
  toLocalInput,
  useMaintenance,
  type MaintenanceWindow,
  type MaintenanceWindowIn,
  type WindowKind,
} from "../../lib/maintenance";
import { useDevices } from "../../lib/queries";

const DAYS: TextKey[] = ["mw.day.0", "mw.day.1", "mw.day.2", "mw.day.3", "mw.day.4", "mw.day.5", "mw.day.6"];
const errorMessage = (err: unknown) => (err instanceof ApiError ? err.message : t("auth.error.generic"));
const iconButton = "flex size-9 items-center justify-center rounded-lg text-text-2 hover:bg-surface-2 hover:text-text disabled:opacity-50";

interface FormValues {
  name: string;
  kind: WindowKind;
  starts: string;
  ends: string;
  days: number[];
  time_from: string;
  hours: string;
  minutes: string;
  all: boolean;
  device_ids: number[];
  note: string;
}

type Errors = Partial<Record<"name" | "starts" | "ends" | "days" | "time_from" | "duration" | "devices", string>>;

function initial(w?: MaintenanceWindow): FormValues {
  const start = new Date(Date.now() + 3600_000);
  start.setMinutes(0, 0, 0);
  const duration = w?.duration_min ?? 120;
  return {
    name: w?.name ?? "",
    kind: w?.kind ?? "once",
    starts: toLocalInput(w?.starts_at ?? start.toISOString()),
    ends: toLocalInput(w?.ends_at ?? new Date(start.getTime() + 2 * 3600_000).toISOString()),
    days: w?.days ?? [5],
    time_from: w?.time_from ?? "02:00",
    hours: String(Math.floor(duration / 60)),
    minutes: String(duration % 60),
    all: !w || w.device_ids.length === 0,
    device_ids: w?.device_ids ?? [],
    note: w?.note ?? "",
  };
}

/** Wartości formularza → treść żądania; `null` = błędy w `errors`. */
export function toRequest(v: FormValues, enabled: boolean): { body: MaintenanceWindowIn | null; errors: Errors } {
  const errors: Errors = {};
  if (!v.name.trim()) errors.name = t("mw.err.name");
  if (!v.all && v.device_ids.length === 0) errors.devices = t("mw.err.devices");
  const base = { name: v.name.trim(), enabled, device_ids: v.all ? [] : v.device_ids, note: v.note.trim() || null, kind: v.kind };
  if (v.kind === "once") {
    const starts = fromLocalInput(v.starts);
    const ends = fromLocalInput(v.ends);
    if (!starts) errors.starts = t("mw.err.starts");
    if (!ends) errors.ends = t("mw.err.ends");
    else if (starts && new Date(ends) <= new Date(starts)) errors.ends = t("mw.err.order");
    else if (starts && new Date(ends).getTime() - new Date(starts).getTime() > 31 * 86400_000) errors.ends = t("mw.err.long");
    const body = { ...base, starts_at: starts, ends_at: ends, days: [], time_from: null, duration_min: null };
    return { body: Object.keys(errors).length ? null : body, errors };
  }
  const minutes = Number(v.hours || 0) * 60 + Number(v.minutes || 0);
  if (v.days.length === 0) errors.days = t("mw.err.days");
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v.time_from)) errors.time_from = t("mw.err.time");
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 7 * 1440) errors.duration = t("mw.err.duration");
  const body = { ...base, starts_at: null, ends_at: null, days: [...v.days].sort(), time_from: v.time_from, duration_min: minutes };
  return { body: Object.keys(errors).length ? null : body, errors };
}

function WindowForm({ window: w, devices, onClose }: { window?: MaintenanceWindow; devices: Device[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [values, setValues] = useState<FormValues>(() => initial(w));
  const [errors, setErrors] = useState<Errors>({});
  const set = <K extends keyof FormValues>(key: K, value: FormValues[K]) => setValues((v) => ({ ...v, [key]: value }));
  const toggleIn = (list: number[], item: number) => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);

  const save = useMutation({
    mutationFn: (body: MaintenanceWindowIn) => (w ? put<MaintenanceWindow>(`/api/maintenance/${w.id}`, body) : post<MaintenanceWindow>("/api/maintenance", body)),
    onSuccess: async () => {
      await Promise.all([qc.invalidateQueries({ queryKey: MAINTENANCE_KEY }), qc.invalidateQueries({ queryKey: ["devices"] })]);
      onClose();
    },
  });

  function submit() {
    const { body, errors: found } = toRequest(values, w?.enabled ?? true);
    setErrors(found);
    if (body) save.mutate(body);
  }

  return (
    <Dialog
      title={w ? t("mw.form.edit", { name: w.name }) : t("mw.form.add")}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" disabled={save.isPending} onClick={submit}>
            {save.isPending ? t("common.saving") : t("common.save")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field id="mw-name" label={t("mw.name")} value={values.name} error={errors.name} maxLength={80} placeholder={t("mw.name.placeholder")} onChange={(e) => set("name", e.target.value)} />

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1.5 text-sm font-medium">{t("mw.kind")}</legend>
          {(["once", "weekly"] as const).map((k) => (
            <label key={k} className="flex items-center gap-2 text-sm">
              <input type="radio" name="mw-kind" checked={values.kind === k} onChange={() => set("kind", k)} className="size-4 accent-accent" />
              {t(`mw.kind.${k}`)}
            </label>
          ))}
        </fieldset>

        {values.kind === "once" ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="mw-starts" type="datetime-local" label={t("mw.starts")} value={values.starts} error={errors.starts} onChange={(e) => set("starts", e.target.value)} />
            <Field id="mw-ends" type="datetime-local" label={t("mw.ends")} value={values.ends} error={errors.ends} onChange={(e) => set("ends", e.target.value)} />
          </div>
        ) : (
          <>
            <fieldset>
              <legend className="mb-1.5 text-sm font-medium">{t("mw.days")}</legend>
              <div className="flex flex-wrap gap-1.5">
                {DAYS.map((label, i) => (
                  <label key={i} className={`cursor-pointer rounded-lg border px-2.5 py-1 text-sm ${values.days.includes(i) ? "border-accent bg-accent-soft text-accent-text" : "border-border-strong"}`}>
                    <input type="checkbox" className="sr-only" checked={values.days.includes(i)} onChange={() => set("days", toggleIn(values.days, i))} />
                    {t(label)}
                  </label>
                ))}
              </div>
              {errors.days && <p className="mt-1.5 text-xs text-danger">{errors.days}</p>}
            </fieldset>
            <div className="grid gap-4 sm:grid-cols-[1fr_6rem_6rem]">
              <Field id="mw-time" type="time" label={t("mw.time")} value={values.time_from} error={errors.time_from} hint={t("mw.time.hint")} onChange={(e) => set("time_from", e.target.value)} />
              <Field id="mw-hours" inputMode="numeric" label={t("mw.hours")} value={values.hours} error={errors.duration} onChange={(e) => set("hours", e.target.value)} />
              <Field id="mw-minutes" inputMode="numeric" label={t("mw.minutes")} value={values.minutes} onChange={(e) => set("minutes", e.target.value)} />
            </div>
          </>
        )}

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1.5 text-sm font-medium">{t("mw.scope")}</legend>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={values.all} onChange={(e) => set("all", e.target.checked)} className="mt-0.5 size-4 accent-accent" />
            <span>
              {t("mw.scope.all")}
              <span className="block text-xs text-muted">{t("mw.scope.all.hint")}</span>
            </span>
          </label>
          {!values.all && (
            <div className="ml-6 flex max-h-48 flex-col gap-1.5 overflow-y-auto">
              {devices.map((d) => (
                <label key={d.id} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={values.device_ids.includes(d.id)} onChange={() => set("device_ids", toggleIn(values.device_ids, d.id))} className="size-4 accent-accent" />
                  {d.name} <span className="text-xs text-muted">{d.host}</span>
                </label>
              ))}
            </div>
          )}
          {errors.devices && <p className="text-xs text-danger">{errors.devices}</p>}
        </fieldset>

        <Field id="mw-note" label={t("mw.note")} value={values.note} maxLength={1000} onChange={(e) => set("note", e.target.value)} />
        {save.isError && <ErrorNote>{errorMessage(save.error)}</ErrorNote>}
      </div>
    </Dialog>
  );
}

function schedule(w: MaintenanceWindow): string {
  if (w.kind === "once") return `${formatDateTime(w.starts_at)} – ${formatDateTime(w.ends_at)}`;
  const days = w.days.length === 7 ? t("mw.everyDay") : w.days.map((d) => t(DAYS[d])).join(", ");
  return t("mw.weekly", { days, time: w.time_from ?? "", duration: formatMinutes(w.duration_min ?? 0) });
}

function WindowRow({ window: w, names, onEdit, onDelete }: { window: MaintenanceWindow; names: Map<number, string>; onEdit: () => void; onDelete: () => void }) {
  const qc = useQueryClient();
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => {
      const { id: _id, created_at: _c, active: _a, active_until: _u, next_start: _n, ...rest } = w;
      return put<MaintenanceWindow>(`/api/maintenance/${w.id}`, { ...rest, enabled });
    },
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: MAINTENANCE_KEY }), qc.invalidateQueries({ queryKey: ["devices"] })]),
  });
  const scope = w.device_ids.length === 0 ? t("mw.scope.everything") : w.device_ids.map((id) => names.get(id) ?? `#${id}`).join(", ");
  const state = !w.enabled
    ? null
    : w.active
      ? t("mw.state.active", { until: formatDateTime(w.active_until) })
      : w.next_start
        ? t("mw.state.next", { when: relativeTime(w.next_start) ?? "" })
        : t("mw.state.past");
  return (
    <li className={`flex flex-col gap-1 px-4 py-3 ${w.enabled ? "" : "opacity-70"}`}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-56">
          <p className="truncate text-sm font-medium">{w.name}</p>
          <p className="text-xs text-text-2">{schedule(w)}</p>
          <p className="truncate text-xs text-text-2">{scope}</p>
          {w.note && <p className="truncate text-xs text-muted">{w.note}</p>}
        </div>
        {w.enabled ? (
          <span className={`rounded-md px-2 py-0.5 text-xs ${w.active ? "bg-warning-soft text-warning" : "bg-surface-2 text-text-2"}`}>{state}</span>
        ) : (
          <span className="rounded-md bg-surface-2 px-2 py-0.5 text-xs text-text-2">{t("devices.disabled")}</span>
        )}
        <div className="flex items-center gap-1">
          <Toggle checked={w.enabled} disabled={toggle.isPending} label={`${t("devices.enabled")}: ${w.name}`} onChange={(v) => toggle.mutate(v)} />
          <button type="button" className={iconButton} aria-label={`${t("common.edit")} ${w.name}`} title={t("common.edit")} onClick={onEdit}>
            <IconPencil size={18} aria-hidden="true" />
          </button>
          <button type="button" className={iconButton} aria-label={`${t("common.delete")} ${w.name}`} title={t("common.delete")} onClick={onDelete}>
            <IconTrash size={18} aria-hidden="true" />
          </button>
        </div>
      </div>
      {toggle.isError && <ErrorNote>{errorMessage(toggle.error)}</ErrorNote>}
    </li>
  );
}

/** Ustawienia → Okna serwisowe: planowane prace bez powiadomień, ich czas nie obniża dostępności. */
export function MaintenancePage() {
  const qc = useQueryClient();
  const { data, isLoading, isError } = useMaintenance();
  const devices = useDevices().data ?? [];
  const names = new Map(devices.map((d) => [d.id, d.name]));
  const [form, setForm] = useState<{ window?: MaintenanceWindow } | null>(null);
  const [toDelete, setToDelete] = useState<MaintenanceWindow | null>(null);
  const remove = useMutation({
    mutationFn: (id: number) => del(`/api/maintenance/${id}`),
    onSuccess: async () => {
      setToDelete(null);
      await Promise.all([qc.invalidateQueries({ queryKey: MAINTENANCE_KEY }), qc.invalidateQueries({ queryKey: ["devices"] })]);
    },
  });
  const list = data ?? [];

  return (
    <>
      <PageHeader title={t("nav.settings.maintenance")}>
        <Button variant="primary" onClick={() => setForm({})}>
          <IconPlus size={18} aria-hidden="true" />
          {t("mw.add")}
        </Button>
      </PageHeader>
      <p className="mb-4 max-w-prose text-sm text-text-2">{t("mw.intro")}</p>

      {isError && !data && <ErrorNote>{t("mw.loadError")}</ErrorNote>}
      {!isLoading && !isError && list.length === 0 && (
        <Card className="p-6">
          <h2 className="text-base font-medium">{t("mw.empty.title")}</h2>
          <p className="mt-1 max-w-prose text-sm text-text-2">{t("mw.empty.body")}</p>
        </Card>
      )}
      {list.length > 0 && (
        <Card>
          <ul className="divide-y divide-border">
            {list.map((w) => (
              <WindowRow
                key={w.id}
                window={w}
                names={names}
                onEdit={() => setForm({ window: w })}
                onDelete={() => {
                  remove.reset();
                  setToDelete(w);
                }}
              />
            ))}
          </ul>
        </Card>
      )}

      {form && <WindowForm window={form.window} devices={devices.filter((d) => d.enabled)} onClose={() => setForm(null)} />}
      {toDelete && (
        <Dialog
          size="sm"
          title={t("mw.delete.title")}
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
          <p className="text-sm">{t("mw.delete.body", { name: toDelete.name })}</p>
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
