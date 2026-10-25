import { IconPencil, IconPlugConnected, IconPlus, IconTrash } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Dialog } from "../../components/Dialog";
import { Button, Card, ErrorNote, Field, PageHeader, SuccessNote, Toggle } from "../../components/ui";
import { t, type TextKey } from "../../i18n";
import { ApiError, del, patch, post } from "../../lib/api";
import { relativeTime } from "../../lib/format";
import { PROXMOX_SERVERS_KEY, useProxmoxServers, type ProxmoxProbe, type ProxmoxServer } from "../../lib/proxmox";

const STATUS_STYLE: Record<string, string> = {
  up: "bg-success-soft text-success",
  down: "bg-danger-soft text-danger",
  unknown: "bg-surface-2 text-text-2",
};
const STATUS_LABEL: Record<string, TextKey> = { up: "dash.status.up", down: "dash.status.down", unknown: "dash.status.unknown" };
const TOKEN_ID_RE = /^[^@\s!]+@[^@\s!]+![A-Za-z0-9_.-]+$/;
const errorMessage = (err: unknown) => (err instanceof ApiError ? err.message : t("auth.error.generic"));
const iconButton = "flex size-9 items-center justify-center rounded-lg text-text-2 hover:bg-surface-2 hover:text-text disabled:opacity-50";

interface FormValues {
  name: string;
  host: string;
  port: string;
  token_id: string;
  token_secret: string;
  verify_tls: boolean;
}

function ProbeOk({ probe }: { probe: ProxmoxProbe }) {
  return (
    <SuccessNote>
      {t("pve.probe.ok", {
        version: probe.version ?? "?",
        cluster: probe.cluster ? t("pve.probe.cluster", { name: probe.cluster }) : t("pve.probe.single"),
        nodes: probe.nodes,
        guests: probe.guests,
      })}
    </SuccessNote>
  );
}

function ServerForm({ server, onClose }: { server?: ProxmoxServer; onClose: () => void }) {
  const qc = useQueryClient();
  const editing = server !== undefined;
  const [values, setValues] = useState<FormValues>({
    name: server?.name ?? "",
    host: server?.host ?? "",
    port: String(server?.port ?? 8006),
    token_id: server?.token_id ?? "",
    token_secret: "",
    verify_tls: server?.verify_tls ?? false,
  });
  const [errors, setErrors] = useState<Partial<Record<keyof FormValues, string>>>({});
  const set = <K extends keyof FormValues>(key: K, value: FormValues[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
  };
  const target = () => ({
    host: values.host.trim(),
    port: Number(values.port),
    token_id: values.token_id.trim(),
    token_secret: values.token_secret.trim(),
    verify_tls: values.verify_tls,
  });

  function validate(): boolean {
    const found: typeof errors = {};
    const secret = values.token_secret.trim();
    if (!values.name.trim()) found.name = t("pve.err.name");
    if (!values.host.trim()) found.host = t("ctrl.err.host");
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) found.port = t("ctrl.err.port");
    if (!TOKEN_ID_RE.test(values.token_id.trim())) found.token_id = t("pve.err.tokenId");
    if ((!editing || secret !== "") && secret.length < 8) found.token_secret = t("pve.err.secret");
    setErrors(found);
    return Object.keys(found).length === 0;
  }

  const probe = useMutation({ mutationFn: () => post<ProxmoxProbe>("/api/proxmox/probe", target()) });
  const save = useMutation({
    mutationFn: () => {
      const { token_secret, ...rest } = target();
      if (server) {
        return patch<ProxmoxServer>(`/api/proxmox/servers/${server.id}`, { name: values.name.trim(), ...rest, ...(token_secret ? { token_secret } : {}) });
      }
      return post<ProxmoxServer>("/api/proxmox/servers", { name: values.name.trim(), token_secret, ...rest });
    },
    onSuccess: async () => {
      await Promise.all([qc.invalidateQueries({ queryKey: PROXMOX_SERVERS_KEY }), qc.invalidateQueries({ queryKey: ["devices"] })]);
      onClose();
    },
  });
  const busy = probe.isPending || save.isPending;

  return (
    <Dialog
      title={editing ? t("ctrl.form.edit", { name: server.name }) : t("pve.form.add")}
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
        <Field id="pve-name" label={t("devform.name")} value={values.name} error={errors.name} maxLength={128} placeholder="Homelab" onChange={(e) => set("name", e.target.value)} />
        <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
          <Field
            id="pve-host"
            label={t("devform.host")}
            value={values.host}
            error={errors.host}
            hint={t("pve.host.hint")}
            placeholder="192.168.1.10"
            autoCapitalize="none"
            spellCheck={false}
            onChange={(e) => set("host", e.target.value)}
          />
          <Field id="pve-port" label={t("devform.port")} inputMode="numeric" value={values.port} error={errors.port} onChange={(e) => set("port", e.target.value)} />
        </div>
        <Field
          id="pve-token-id"
          label={t("pve.tokenId")}
          value={values.token_id}
          error={errors.token_id}
          hint={t("pve.tokenId.hint")}
          placeholder="netpulse@pve!monitor"
          autoCapitalize="none"
          spellCheck={false}
          onChange={(e) => set("token_id", e.target.value)}
        />
        <Field
          id="pve-token-secret"
          label={t("pve.secret")}
          type="password"
          autoComplete="off"
          value={values.token_secret}
          error={errors.token_secret}
          hint={editing ? t("pve.secret.keep") : t("pve.secret.hint")}
          onChange={(e) => set("token_secret", e.target.value)}
        />
        <label htmlFor="pve-tls" className="flex items-start gap-2 text-sm">
          <input id="pve-tls" type="checkbox" checked={values.verify_tls} onChange={(e) => set("verify_tls", e.target.checked)} className="mt-0.5 size-4 accent-accent" />
          <span>
            {t("ctrl.tls")}
            <span className="block text-xs text-muted">{t("pve.tls.hint")}</span>
          </span>
        </label>
        {probe.isSuccess && <ProbeOk probe={probe.data} />}
        {probe.isError && <ErrorNote>{errorMessage(probe.error)}</ErrorNote>}
        {save.isError && <ErrorNote>{errorMessage(save.error)}</ErrorNote>}
      </div>
    </Dialog>
  );
}

function ServerRow({ server, onEdit, onDelete }: { server: ProxmoxServer; onEdit: () => void; onDelete: () => void }) {
  const qc = useQueryClient();
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => patch<ProxmoxServer>(`/api/proxmox/servers/${server.id}`, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: PROXMOX_SERVERS_KEY }),
  });
  const test = useMutation({ mutationFn: () => post<ProxmoxProbe>(`/api/proxmox/servers/${server.id}/probe`) });
  const status = server.status in STATUS_STYLE ? server.status : "unknown";
  const details = [
    `${server.host}:${server.port}`,
    server.version ? `Proxmox VE ${server.version}` : null,
    server.cluster_name ? t("pve.probe.cluster", { name: server.cluster_name }) : null,
  ].filter(Boolean);

  return (
    <li className={`flex flex-col gap-2 px-4 py-3 ${server.enabled ? "" : "opacity-70"}`}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-56">
          <p className="truncate text-sm font-medium">{server.name}</p>
          <p className="truncate text-xs text-text-2">{details.join(" · ")}</p>
        </div>
        {server.enabled ? (
          <span className={`rounded-md px-2 py-0.5 text-xs ${STATUS_STYLE[status]}`} title={relativeTime(server.last_polled_at) ?? undefined}>
            {t(STATUS_LABEL[status])}
          </span>
        ) : (
          <span className="rounded-md bg-surface-2 px-2 py-0.5 text-xs text-text-2">{t("devices.disabled")}</span>
        )}
        <div className="flex items-center gap-1">
          <Toggle checked={server.enabled} disabled={toggle.isPending} label={`${t("devices.enabled")}: ${server.name}`} onChange={(v) => toggle.mutate(v)} />
          <button type="button" className={iconButton} aria-label={`${t("devices.test")} ${server.name}`} title={t("devices.test")} disabled={test.isPending} onClick={() => test.mutate()}>
            <IconPlugConnected size={18} aria-hidden="true" />
          </button>
          <button type="button" className={iconButton} aria-label={`${t("common.edit")} ${server.name}`} title={t("common.edit")} onClick={onEdit}>
            <IconPencil size={18} aria-hidden="true" />
          </button>
          <button type="button" className={iconButton} aria-label={`${t("common.delete")} ${server.name}`} title={t("common.delete")} onClick={onDelete}>
            <IconTrash size={18} aria-hidden="true" />
          </button>
        </div>
      </div>
      {server.enabled && server.status === "down" && server.last_error && <ErrorNote>{server.last_error}</ErrorNote>}
      {test.isSuccess && <ProbeOk probe={test.data} />}
      {test.isError && <ErrorNote>{errorMessage(test.error)}</ErrorNote>}
    </li>
  );
}

/** Ustawienia → Proxmox: serwery Proxmox VE (token API tylko do odczytu). */
export function ProxmoxSettingsPage() {
  const qc = useQueryClient();
  const { data, isLoading, isError } = useProxmoxServers();
  const [form, setForm] = useState<{ server?: ProxmoxServer } | null>(null);
  const [toDelete, setToDelete] = useState<ProxmoxServer | null>(null);
  const remove = useMutation({
    mutationFn: (id: number) => del(`/api/proxmox/servers/${id}`),
    onSuccess: async () => {
      setToDelete(null);
      await Promise.all([
        qc.invalidateQueries({ queryKey: PROXMOX_SERVERS_KEY }),
        qc.invalidateQueries({ queryKey: ["devices"] }),
        qc.invalidateQueries({ queryKey: ["proxmox"] }),
      ]);
    },
  });
  const list = data ?? [];

  return (
    <>
      <PageHeader title={t("settings.proxmox.title")}>
        <Button variant="primary" onClick={() => setForm({})}>
          <IconPlus size={18} aria-hidden="true" />
          {t("pve.add")}
        </Button>
      </PageHeader>
      <p className="mb-2 max-w-prose text-sm text-text-2">{t("pve.intro")}</p>
      <ol className="mb-4 max-w-prose list-decimal pl-5 text-xs text-text-2">
        <li>{t("pve.howto.1")}</li>
        <li>{t("pve.howto.2")}</li>
        <li>{t("pve.howto.3")}</li>
      </ol>

      {isError && !data && <ErrorNote>{t("pve.loadError")}</ErrorNote>}
      {!isLoading && !isError && list.length === 0 && (
        <Card className="p-6">
          <h2 className="text-base font-medium">{t("pve.empty.title")}</h2>
          <p className="mt-1 max-w-prose text-sm text-text-2">{t("pve.empty.body")}</p>
        </Card>
      )}
      {list.length > 0 && (
        <Card>
          <ul className="divide-y divide-border">
            {list.map((s) => (
              <ServerRow
                key={s.id}
                server={s}
                onEdit={() => setForm({ server: s })}
                onDelete={() => {
                  remove.reset();
                  setToDelete(s);
                }}
              />
            ))}
          </ul>
        </Card>
      )}

      {form && <ServerForm server={form.server} onClose={() => setForm(null)} />}
      {toDelete && (
        <Dialog
          size="sm"
          title={t("pve.delete.title")}
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
          <p className="text-sm">{t("pve.delete.body", { name: toDelete.name })}</p>
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
