import { IconPencil, IconPlugConnected, IconPlus, IconTrash } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Dialog } from "../../components/Dialog";
import { Button, Card, ErrorNote, Field, PageHeader, SuccessNote, Toggle } from "../../components/ui";
import { t, type TextKey } from "../../i18n";
import { ApiError, del, patch, post } from "../../lib/api";
import { relativeTime } from "../../lib/format";
import { CONTROLLERS_KEY, useControllers, type Controller, type ControllerProbe } from "../../lib/unifi";

const STATUS_STYLE: Record<string, string> = {
  up: "bg-success-soft text-success",
  down: "bg-danger-soft text-danger",
  unknown: "bg-surface-2 text-text-2",
};
const STATUS_LABEL: Record<string, TextKey> = {
  up: "dash.status.up",
  down: "dash.status.down",
  unknown: "dash.status.unknown",
};

const errorMessage = (err: unknown) => (err instanceof ApiError ? err.message : t("auth.error.generic"));
const iconButton = "flex size-9 items-center justify-center rounded-lg text-text-2 hover:bg-surface-2 hover:text-text disabled:opacity-50";

interface FormValues {
  name: string;
  host: string;
  port: string;
  api_key: string;
  site: string;
  verify_tls: boolean;
}

function ProbeOk({ probe }: { probe: ControllerProbe }) {
  return (
    <SuccessNote>
      {t("ctrl.probe.ok", { version: probe.app_version ?? "?", devices: probe.devices, clients: probe.clients })}
    </SuccessNote>
  );
}

function ControllerForm({ controller, onClose }: { controller?: Controller; onClose: () => void }) {
  const qc = useQueryClient();
  const editing = controller !== undefined;
  const [values, setValues] = useState<FormValues>({
    name: controller?.name ?? "",
    host: controller?.host ?? "",
    port: String(controller?.port ?? 443),
    api_key: "",
    site: controller?.site ?? "default",
    verify_tls: controller?.verify_tls ?? false,
  });
  const [errors, setErrors] = useState<Partial<Record<keyof FormValues, string>>>({});
  const set = <K extends keyof FormValues>(key: K, value: FormValues[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
  };

  const target = () => ({
    host: values.host.trim(),
    port: Number(values.port),
    api_key: values.api_key.trim(),
    site: values.site.trim(),
    verify_tls: values.verify_tls,
  });

  function validate(): boolean {
    const found: typeof errors = {};
    const key = values.api_key.trim();
    if (!values.name.trim()) found.name = t("ctrl.err.name");
    if (!values.host.trim()) found.host = t("ctrl.err.host");
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) found.port = t("ctrl.err.port");
    if ((!editing || key !== "") && key.length < 8) found.api_key = t("ctrl.err.key");
    if (!values.site.trim()) found.site = t("ctrl.err.site");
    setErrors(found);
    return Object.keys(found).length === 0;
  }

  const probe = useMutation({ mutationFn: () => post<ControllerProbe>("/api/controllers/probe", target()) });
  const save = useMutation({
    mutationFn: () => {
      const { api_key, ...rest } = target();
      if (controller) {
        // Pusty klucz przy edycji = bez zmiany klucza
        return patch<Controller>(`/api/controllers/${controller.id}`, { name: values.name.trim(), ...rest, ...(api_key ? { api_key } : {}) });
      }
      return post<Controller>("/api/controllers", { name: values.name.trim(), api_key, ...rest });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: CONTROLLERS_KEY });
      onClose();
    },
  });
  const busy = probe.isPending || save.isPending;

  return (
    <Dialog
      title={editing ? t("ctrl.form.edit", { name: controller.name }) : t("ctrl.form.add")}
      onClose={onClose}
      footer={
        <>
          {!editing && (
            <Button className="mr-auto" disabled={busy} onClick={() => validate() && probe.mutate()}>
              {probe.isPending ? t("devices.testing") : t("devform.test")}
            </Button>
          )}
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" disabled={busy} onClick={() => validate() && save.mutate()}>
            {save.isPending ? t("common.saving") : t("common.save")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field id="ctrl-name" label={t("devform.name")} value={values.name} error={errors.name} maxLength={128} onChange={(e) => set("name", e.target.value)} />
        <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
          <Field
            id="ctrl-host"
            label={t("devform.host")}
            value={values.host}
            error={errors.host}
            placeholder="192.168.1.1"
            autoCapitalize="none"
            spellCheck={false}
            onChange={(e) => set("host", e.target.value)}
          />
          <Field id="ctrl-port" label={t("devform.port")} inputMode="numeric" value={values.port} error={errors.port} onChange={(e) => set("port", e.target.value)} />
        </div>
        <Field
          id="ctrl-key"
          label={t("ctrl.key")}
          type="password"
          autoComplete="off"
          value={values.api_key}
          error={errors.api_key}
          hint={editing ? t("ctrl.key.keep") : t("ctrl.key.hint")}
          onChange={(e) => set("api_key", e.target.value)}
        />
        <Field id="ctrl-site" label={t("ctrl.site")} value={values.site} error={errors.site} hint={t("ctrl.site.hint")} onChange={(e) => set("site", e.target.value)} />
        <label htmlFor="ctrl-tls" className="flex items-start gap-2 text-sm">
          <input id="ctrl-tls" type="checkbox" checked={values.verify_tls} onChange={(e) => set("verify_tls", e.target.checked)} className="mt-0.5 size-4 accent-accent" />
          <span>
            {t("ctrl.tls")}
            <span className="block text-xs text-muted">{t("ctrl.tls.hint")}</span>
          </span>
        </label>

        {probe.isSuccess && <ProbeOk probe={probe.data} />}
        {probe.isError && <ErrorNote>{errorMessage(probe.error)}</ErrorNote>}
        {save.isError && <ErrorNote>{errorMessage(save.error)}</ErrorNote>}
      </div>
    </Dialog>
  );
}

function ControllerRow({ controller, onEdit, onDelete }: { controller: Controller; onEdit: () => void; onDelete: () => void }) {
  const qc = useQueryClient();
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => patch<Controller>(`/api/controllers/${controller.id}`, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: CONTROLLERS_KEY }),
  });
  const test = useMutation({ mutationFn: () => post<ControllerProbe>(`/api/controllers/${controller.id}/probe`) });
  const status = controller.status in STATUS_STYLE ? controller.status : "unknown";
  const polled = relativeTime(controller.last_polled_at);

  return (
    <li className={`flex flex-col gap-2 px-4 py-3 ${controller.enabled ? "" : "opacity-70"}`}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-56">
          <p className="truncate text-sm font-medium">{controller.name}</p>
          <p className="truncate text-xs text-text-2">
            {controller.host}:{controller.port} · {t("ctrl.row.site", { site: controller.site })}
            {controller.app_version ? ` · UniFi Network ${controller.app_version}` : ""}
          </p>
        </div>
        {controller.enabled ? (
          <span className={`rounded-md px-2 py-0.5 text-xs ${STATUS_STYLE[status]}`} title={polled ?? undefined}>
            {t(STATUS_LABEL[status])}
          </span>
        ) : (
          <span className="rounded-md bg-surface-2 px-2 py-0.5 text-xs text-text-2">{t("devices.disabled")}</span>
        )}
        <div className="flex items-center gap-1">
          <Toggle checked={controller.enabled} disabled={toggle.isPending} label={`${t("devices.enabled")}: ${controller.name}`} onChange={(v) => toggle.mutate(v)} />
          <button type="button" className={iconButton} aria-label={`${t("devices.test")} ${controller.name}`} title={t("devices.test")} disabled={test.isPending} onClick={() => test.mutate()}>
            <IconPlugConnected size={18} aria-hidden="true" />
          </button>
          <button type="button" className={iconButton} aria-label={`${t("common.edit")} ${controller.name}`} title={t("common.edit")} onClick={onEdit}>
            <IconPencil size={18} aria-hidden="true" />
          </button>
          <button type="button" className={iconButton} aria-label={`${t("common.delete")} ${controller.name}`} title={t("common.delete")} onClick={onDelete}>
            <IconTrash size={18} aria-hidden="true" />
          </button>
        </div>
      </div>
      {controller.enabled && controller.status === "down" && controller.last_error && <ErrorNote>{controller.last_error}</ErrorNote>}
      {test.isSuccess && <ProbeOk probe={test.data} />}
      {test.isError && <ErrorNote>{errorMessage(test.error)}</ErrorNote>}
    </li>
  );
}

/** Ustawienia → Kontrolery UniFi: klucz API daje PoE na portach i listę klientów, których SNMP nie podaje. */
export function ControllersPage() {
  const qc = useQueryClient();
  const { data, isLoading, isError } = useControllers();
  const [form, setForm] = useState<{ controller?: Controller } | null>(null);
  const [toDelete, setToDelete] = useState<Controller | null>(null);
  const remove = useMutation({
    mutationFn: (id: number) => del(`/api/controllers/${id}`),
    onSuccess: async () => {
      setToDelete(null);
      await Promise.all([qc.invalidateQueries({ queryKey: CONTROLLERS_KEY }), qc.invalidateQueries({ queryKey: ["clients"] })]);
    },
  });
  const list = data ?? [];

  return (
    <>
      <PageHeader title={t("settings.controllers.title")}>
        <Button variant="primary" onClick={() => setForm({})}>
          <IconPlus size={18} aria-hidden="true" />
          {t("ctrl.add")}
        </Button>
      </PageHeader>
      <p className="mb-4 max-w-prose text-sm text-text-2">{t("ctrl.intro")}</p>

      {isError && !data && <ErrorNote>{t("ctrl.loadError")}</ErrorNote>}
      {!isLoading && !isError && list.length === 0 && (
        <Card className="p-6">
          <h2 className="text-base font-medium">{t("ctrl.empty.title")}</h2>
          <p className="mt-1 max-w-prose text-sm text-text-2">{t("ctrl.empty.body")}</p>
        </Card>
      )}
      {list.length > 0 && (
        <Card>
          <ul className="divide-y divide-border">
            {list.map((c) => (
              <ControllerRow
                key={c.id}
                controller={c}
                onEdit={() => setForm({ controller: c })}
                onDelete={() => {
                  remove.reset();
                  setToDelete(c);
                }}
              />
            ))}
          </ul>
        </Card>
      )}

      {form && <ControllerForm controller={form.controller} onClose={() => setForm(null)} />}
      {toDelete && (
        <Dialog
          size="sm"
          title={t("ctrl.delete.title")}
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
          <p className="text-sm">{t("ctrl.delete.body", { name: toDelete.name })}</p>
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
