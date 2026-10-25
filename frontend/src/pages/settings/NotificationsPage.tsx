import { IconPencil, IconPlus, IconSend, IconTrash } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Dialog } from "../../components/Dialog";
import { Button, Card, ErrorNote, Field, PageHeader, Select, SuccessNote, Toggle } from "../../components/ui";
import { t } from "../../i18n";
import { ApiError, del, patch, post } from "../../lib/api";
import { SEVERITIES, type Severity } from "../../lib/alerts";
import { relativeTime } from "../../lib/format";
import { CHANNELS_KEY, isValidWebhookUrl, useChannels, type ChannelTestResult, type NotificationChannel } from "../../lib/notifications";

const errorMessage = (err: unknown) => (err instanceof ApiError ? err.message : t("auth.error.generic"));
const iconButton = "flex size-9 items-center justify-center rounded-lg text-text-2 hover:bg-surface-2 hover:text-text disabled:opacity-50";

interface FormValues {
  name: string;
  url: string;
  min_severity: Severity;
  notify_resolved: boolean;
}

function ChannelForm({ channel, onClose }: { channel?: NotificationChannel; onClose: () => void }) {
  const qc = useQueryClient();
  const editing = channel !== undefined;
  const [values, setValues] = useState<FormValues>({
    name: channel?.name ?? "",
    url: "",
    min_severity: channel?.min_severity ?? "warning",
    notify_resolved: channel?.notify_resolved ?? true,
  });
  const [errors, setErrors] = useState<{ name?: string; url?: string }>({});
  const set = <K extends keyof FormValues>(key: K, value: FormValues[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
  };

  const save = useMutation({
    mutationFn: () => {
      const body = { name: values.name.trim(), min_severity: values.min_severity, notify_resolved: values.notify_resolved };
      const url = values.url.trim();
      // Pusty adres przy edycji = bez zmiany zapisanego adresu
      return channel
        ? patch<NotificationChannel>(`/api/notification-channels/${channel.id}`, { ...body, ...(url ? { url } : {}) })
        : post<NotificationChannel>("/api/notification-channels", { ...body, url });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: CHANNELS_KEY });
      onClose();
    },
  });

  function submit() {
    const found: typeof errors = {};
    if (!values.name.trim()) found.name = t("notif.err.name");
    const url = values.url.trim();
    if ((!editing || url !== "") && !isValidWebhookUrl(url)) found.url = t("notif.err.url");
    setErrors(found);
    if (Object.keys(found).length === 0) save.mutate();
  }

  return (
    <Dialog
      title={editing ? t("notif.form.edit", { name: channel.name }) : t("notif.form.add")}
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
        <Field id="notif-name" label={t("devform.name")} value={values.name} error={errors.name} maxLength={128} placeholder="Telegram" onChange={(e) => set("name", e.target.value)} />
        <Field
          id="notif-url"
          label={t("notif.url")}
          type="password"
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="none"
          value={values.url}
          error={errors.url}
          hint={editing ? t("notif.url.keep") : t("notif.url.hint")}
          onChange={(e) => set("url", e.target.value)}
        />
        <Select id="notif-severity" label={t("notif.severity")} value={values.min_severity} onChange={(e) => set("min_severity", e.target.value as Severity)}>
          {[...SEVERITIES].reverse().map((s) => (
            <option key={s} value={s}>
              {t(`notif.severity.${s}` as const)}
            </option>
          ))}
        </Select>
        <label htmlFor="notif-resolved" className="flex items-start gap-2 text-sm">
          <input id="notif-resolved" type="checkbox" checked={values.notify_resolved} onChange={(e) => set("notify_resolved", e.target.checked)} className="mt-0.5 size-4 accent-accent" />
          <span>{t("notif.resolved")}</span>
        </label>
        {save.isError && <ErrorNote>{errorMessage(save.error)}</ErrorNote>}
      </div>
    </Dialog>
  );
}

function ChannelRow({ channel, onEdit, onDelete }: { channel: NotificationChannel; onEdit: () => void; onDelete: () => void }) {
  const qc = useQueryClient();
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => patch<NotificationChannel>(`/api/notification-channels/${channel.id}`, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: CHANNELS_KEY }),
  });
  const test = useMutation({
    mutationFn: () => post<ChannelTestResult>(`/api/notification-channels/${channel.id}/test`),
    onSuccess: () => qc.invalidateQueries({ queryKey: CHANNELS_KEY }),
  });
  const sent = relativeTime(channel.last_sent_at);

  return (
    <li className={`flex flex-col gap-2 px-4 py-3 ${channel.enabled ? "" : "opacity-70"}`}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-56">
          <p className="truncate text-sm font-medium">{channel.name}</p>
          <p className="truncate text-xs text-text-2">
            {channel.url_hint} · {t(`notif.row.from.${channel.min_severity}` as const)}
            {channel.notify_resolved ? ` · ${t("notif.row.resolved")}` : ""}
          </p>
        </div>
        {channel.last_status === "ok" && (
          <span className="rounded-md bg-success-soft px-2 py-0.5 text-xs text-success" title={sent ?? undefined}>
            {t("notif.status.ok")}
          </span>
        )}
        {channel.last_status === "error" && <span className="rounded-md bg-danger-soft px-2 py-0.5 text-xs text-danger">{t("notif.status.error")}</span>}
        <div className="flex items-center gap-1">
          <Toggle checked={channel.enabled} disabled={toggle.isPending} label={`${t("notif.enabled")}: ${channel.name}`} onChange={(v) => toggle.mutate(v)} />
          <button type="button" className={iconButton} aria-label={`${t("notif.test")} ${channel.name}`} title={t("notif.test")} disabled={test.isPending} onClick={() => test.mutate()}>
            <IconSend size={18} aria-hidden="true" />
          </button>
          <button type="button" className={iconButton} aria-label={`${t("common.edit")} ${channel.name}`} title={t("common.edit")} onClick={onEdit}>
            <IconPencil size={18} aria-hidden="true" />
          </button>
          <button type="button" className={iconButton} aria-label={`${t("common.delete")} ${channel.name}`} title={t("common.delete")} onClick={onDelete}>
            <IconTrash size={18} aria-hidden="true" />
          </button>
        </div>
      </div>
      {channel.last_status === "error" && channel.last_error && <ErrorNote>{channel.last_error}</ErrorNote>}
      {test.isSuccess && test.data.ok && <SuccessNote>{t("notif.test.ok")}</SuccessNote>}
      {test.isSuccess && !test.data.ok && <ErrorNote>{t("notif.test.fail", { error: test.data.error ?? "" })}</ErrorNote>}
      {test.isError && <ErrorNote>{errorMessage(test.error)}</ErrorNote>}
    </li>
  );
}

/** Ustawienia → Powiadomienia: webhook, który dostaje alerty także wtedy, gdy panel nie jest otwarty. */
export function NotificationsPage() {
  const qc = useQueryClient();
  const { data, isLoading, isError } = useChannels();
  const [form, setForm] = useState<{ channel?: NotificationChannel } | null>(null);
  const [toDelete, setToDelete] = useState<NotificationChannel | null>(null);
  const remove = useMutation({
    mutationFn: (id: number) => del(`/api/notification-channels/${id}`),
    onSuccess: async () => {
      setToDelete(null);
      await qc.invalidateQueries({ queryKey: CHANNELS_KEY });
    },
  });
  const list = data ?? [];

  return (
    <>
      <PageHeader title={t("settings.notifications.title")}>
        <Button variant="primary" onClick={() => setForm({})}>
          <IconPlus size={18} aria-hidden="true" />
          {t("notif.add")}
        </Button>
      </PageHeader>
      <p className="mb-4 max-w-prose text-sm text-text-2">{t("notif.intro")}</p>

      {isError && !data && <ErrorNote>{t("notif.loadError")}</ErrorNote>}
      {!isLoading && !isError && list.length === 0 && (
        <Card className="p-6">
          <h2 className="text-base font-medium">{t("notif.empty.title")}</h2>
          <p className="mt-1 max-w-prose text-sm text-text-2">{t("notif.empty.body")}</p>
        </Card>
      )}
      {list.length > 0 && (
        <Card>
          <ul className="divide-y divide-border">
            {list.map((c) => (
              <ChannelRow
                key={c.id}
                channel={c}
                onEdit={() => setForm({ channel: c })}
                onDelete={() => {
                  remove.reset();
                  setToDelete(c);
                }}
              />
            ))}
          </ul>
        </Card>
      )}

      {form && <ChannelForm channel={form.channel} onClose={() => setForm(null)} />}
      {toDelete && (
        <Dialog
          size="sm"
          title={t("notif.delete.title")}
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
          <p className="text-sm">{t("notif.delete.body", { name: toDelete.name })}</p>
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
