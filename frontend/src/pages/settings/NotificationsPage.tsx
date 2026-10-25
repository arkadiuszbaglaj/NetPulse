import { IconPencil, IconPlus, IconSend, IconTrash } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Dialog } from "../../components/Dialog";
import { Button, Card, ErrorNote, Field, PageHeader, Select, SuccessNote, Toggle } from "../../components/ui";
import { t } from "../../i18n";
import { ApiError, del, patch, post } from "../../lib/api";
import { SEVERITIES, type Severity } from "../../lib/alerts";
import { relativeTime } from "../../lib/format";
import {
  CHANNEL_KINDS,
  CHANNELS_KEY,
  isValidEmail,
  isValidNtfyUrl,
  isValidWebhookUrl,
  parseRecipients,
  useChannels,
  type ChannelKind,
  type ChannelTestResult,
  type EmailConfig,
  type NotificationChannel,
} from "../../lib/notifications";

const errorMessage = (err: unknown) => (err instanceof ApiError ? err.message : t("auth.error.generic"));
const iconButton = "flex size-9 items-center justify-center rounded-lg text-text-2 hover:bg-surface-2 hover:text-text disabled:opacity-50";
const SECURITY_PORT: Record<EmailConfig["security"], string> = { starttls: "587", ssl: "465", none: "25" };

interface FormValues {
  kind: ChannelKind;
  name: string;
  url: string;
  secret: string;
  clearSecret: boolean;
  host: string;
  port: string;
  security: EmailConfig["security"];
  username: string;
  sender: string;
  recipients: string;
  min_severity: Severity;
  notify_resolved: boolean;
  quiet: boolean;
  quiet_from: string;
  quiet_to: string;
  quiet_critical: boolean;
}

type Errors = Partial<Record<"name" | "url" | "host" | "port" | "sender" | "recipients" | "quiet", string>>;

function initialValues(channel?: NotificationChannel): FormValues {
  const email = channel?.email;
  return {
    kind: channel?.kind ?? "webhook",
    name: channel?.name ?? "",
    url: "",
    secret: "",
    clearSecret: false,
    host: email?.host ?? "",
    port: String(email?.port ?? 587),
    security: email?.security ?? "starttls",
    username: email?.username ?? "",
    sender: email?.sender ?? "",
    recipients: email?.recipients.join(", ") ?? "",
    min_severity: channel?.min_severity ?? "warning",
    notify_resolved: channel?.notify_resolved ?? true,
    quiet: Boolean(channel?.quiet_from && channel?.quiet_to),
    quiet_from: channel?.quiet_from ?? "22:00",
    quiet_to: channel?.quiet_to ?? "07:00",
    quiet_critical: channel?.quiet_critical ?? true,
  };
}

function validate(v: FormValues, editing: boolean): Errors {
  const found: Errors = {};
  if (!v.name.trim()) found.name = t("notif.err.name");
  const url = v.url.trim();
  if (v.kind === "webhook" && (!editing || url !== "") && !isValidWebhookUrl(url)) found.url = t("notif.err.url");
  if (v.kind === "ntfy" && (!editing || url !== "") && !isValidNtfyUrl(url)) found.url = t("notif.err.ntfy");
  if (v.kind === "email") {
    if (!v.host.trim()) found.host = t("notif.err.host");
    const port = Number(v.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) found.port = t("notif.err.port");
    if (v.sender.trim() && !isValidEmail(v.sender)) found.sender = t("notif.err.email");
    const recipients = parseRecipients(v.recipients);
    if (!recipients.length || !recipients.every(isValidEmail)) found.recipients = t("notif.err.recipients");
  }
  if (v.quiet && (!v.quiet_from || !v.quiet_to || v.quiet_from === v.quiet_to)) found.quiet = t("notif.err.quiet");
  return found;
}

function requestBody(v: FormValues, editing: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: v.name.trim(),
    min_severity: v.min_severity,
    notify_resolved: v.notify_resolved,
    quiet_from: v.quiet ? v.quiet_from : null,
    quiet_to: v.quiet ? v.quiet_to : null,
    quiet_critical: v.quiet_critical,
  };
  if (!editing) body.kind = v.kind;
  // Puste pole sekretu przy edycji = bez zmiany zapisanego adresu, tokenu albo hasła
  const url = v.url.trim();
  if (v.kind !== "email" && url) body.url = url;
  if (v.kind !== "webhook") {
    if (v.secret) body.secret = v.secret;
    else if (editing && v.clearSecret) body.secret = "";
  }
  if (v.kind === "email") {
    body.email = {
      host: v.host.trim(),
      port: Number(v.port),
      security: v.security,
      username: v.username.trim() || null,
      sender: v.sender.trim() || null,
      recipients: parseRecipients(v.recipients),
    };
  }
  return body;
}

function Checkbox({ id, label, checked, onChange }: { id: string; label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label htmlFor={id} className="flex items-start gap-2 text-sm">
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 size-4 accent-accent" />
      <span>{label}</span>
    </label>
  );
}

const secretInput = { type: "password", autoComplete: "off", spellCheck: false, autoCapitalize: "none" } as const;

function ChannelForm({ channel, timezone, onClose }: { channel?: NotificationChannel; timezone: string; onClose: () => void }) {
  const qc = useQueryClient();
  const editing = channel !== undefined;
  const [values, setValues] = useState<FormValues>(() => initialValues(channel));
  const [errors, setErrors] = useState<Errors>({});
  const set = <K extends keyof FormValues>(key: K, value: FormValues[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined, ...(key.startsWith("quiet") ? { quiet: undefined } : {}) }));
  };

  const save = useMutation({
    mutationFn: () => {
      const body = requestBody(values, editing);
      return channel
        ? patch<NotificationChannel>(`/api/notification-channels/${channel.id}`, body)
        : post<NotificationChannel>("/api/notification-channels", body);
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: CHANNELS_KEY });
      onClose();
    },
  });

  function submit() {
    const found = validate(values, editing);
    setErrors(found);
    if (Object.keys(found).length === 0) save.mutate();
  }

  const kind = values.kind;
  const keepHint = editing ? t("notif.secret.keep") : undefined;
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
        {!editing && (
          <Select id="notif-kind" label={t("notif.kind")} value={kind} onChange={(e) => set("kind", e.target.value as ChannelKind)}>
            {CHANNEL_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`notif.kind.${k}` as const)}
              </option>
            ))}
          </Select>
        )}
        <p className="-mt-2 text-xs text-text-2">{t(`notif.kind.${kind}.hint` as const)}</p>
        <Field
          id="notif-name"
          label={t("devform.name")}
          value={values.name}
          error={errors.name}
          maxLength={128}
          placeholder={kind === "email" ? "E-mail" : kind === "ntfy" ? "ntfy" : "Telegram"}
          onChange={(e) => set("name", e.target.value)}
        />

        {kind === "webhook" && (
          <Field
            id="notif-url"
            label={t("notif.url")}
            {...secretInput}
            value={values.url}
            error={errors.url}
            hint={editing ? t("notif.url.keep") : t("notif.url.hint")}
            onChange={(e) => set("url", e.target.value)}
          />
        )}

        {kind === "ntfy" && (
          <>
            <Field
              id="notif-url"
              label={t("notif.ntfy.url")}
              {...secretInput}
              placeholder="https://ntfy.sh/moj-temat"
              value={values.url}
              error={errors.url}
              hint={editing ? t("notif.url.keep") : t("notif.ntfy.url.hint")}
              onChange={(e) => set("url", e.target.value)}
            />
            <Field
              id="notif-secret"
              label={t("notif.ntfy.token")}
              {...secretInput}
              value={values.secret}
              hint={keepHint ?? t("notif.ntfy.token.hint")}
              onChange={(e) => set("secret", e.target.value)}
            />
          </>
        )}

        {kind === "email" && (
          <>
            <div className="grid gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
              <Field id="notif-host" label={t("notif.smtp.host")} placeholder="smtp.gmail.com" value={values.host} error={errors.host} onChange={(e) => set("host", e.target.value)} />
              <Field id="notif-port" label={t("notif.smtp.port")} inputMode="numeric" value={values.port} error={errors.port} onChange={(e) => set("port", e.target.value)} />
            </div>
            <Select
              id="notif-security"
              label={t("notif.smtp.security")}
              value={values.security}
              onChange={(e) => {
                const security = e.target.value as EmailConfig["security"];
                // Port domyślny dla trybu, o ile użytkownik nie wpisał własnego
                setValues((v) => ({ ...v, security, port: Object.values(SECURITY_PORT).includes(v.port) ? SECURITY_PORT[security] : v.port }));
              }}
            >
              <option value="starttls">{t("notif.smtp.starttls")}</option>
              <option value="ssl">{t("notif.smtp.ssl")}</option>
              <option value="none">{t("notif.smtp.none")}</option>
            </Select>
            <Field id="notif-username" label={t("notif.smtp.username")} autoComplete="off" value={values.username} onChange={(e) => set("username", e.target.value)} />
            <Field id="notif-secret" label={t("notif.smtp.password")} {...secretInput} value={values.secret} hint={keepHint ?? t("notif.smtp.password.hint")} onChange={(e) => set("secret", e.target.value)} />
            <Field id="notif-sender" label={t("notif.smtp.sender")} value={values.sender} error={errors.sender} hint={t("notif.smtp.sender.hint")} onChange={(e) => set("sender", e.target.value)} />
            <Field id="notif-recipients" label={t("notif.smtp.recipients")} value={values.recipients} error={errors.recipients} hint={t("notif.smtp.recipients.hint")} onChange={(e) => set("recipients", e.target.value)} />
          </>
        )}
        {editing && kind !== "webhook" && channel.has_secret && (
          <Checkbox id="notif-clear-secret" label={t(kind === "email" ? "notif.smtp.clear" : "notif.ntfy.clear")} checked={values.clearSecret} onChange={(v) => set("clearSecret", v)} />
        )}

        <Select id="notif-severity" label={t("notif.severity")} value={values.min_severity} onChange={(e) => set("min_severity", e.target.value as Severity)}>
          {[...SEVERITIES].reverse().map((s) => (
            <option key={s} value={s}>
              {t(`notif.severity.${s}` as const)}
            </option>
          ))}
        </Select>
        <Checkbox id="notif-resolved" label={t("notif.resolved")} checked={values.notify_resolved} onChange={(v) => set("notify_resolved", v)} />

        <fieldset className="flex flex-col gap-3 rounded-lg border border-border p-3">
          <legend className="px-1 text-sm font-medium">{t("notif.quiet")}</legend>
          <Checkbox id="notif-quiet" label={t("notif.quiet.on")} checked={values.quiet} onChange={(v) => set("quiet", v)} />
          {values.quiet && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Field id="notif-quiet-from" label={t("notif.quiet.from")} type="time" value={values.quiet_from} onChange={(e) => set("quiet_from", e.target.value)} />
                <Field id="notif-quiet-to" label={t("notif.quiet.to")} type="time" value={values.quiet_to} onChange={(e) => set("quiet_to", e.target.value)} />
              </div>
              <Checkbox id="notif-quiet-critical" label={t("notif.quiet.critical")} checked={values.quiet_critical} onChange={(v) => set("quiet_critical", v)} />
              <p className="text-xs text-text-2">{t("notif.quiet.hint", { tz: timezone })}</p>
            </>
          )}
          {errors.quiet && <p className="text-xs text-danger">{errors.quiet}</p>}
        </fieldset>
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
            {[
              channel.kind !== "webhook" ? t(`notif.kind.${channel.kind}` as const) : null,
              channel.url_hint,
              t(`notif.row.from.${channel.min_severity}` as const),
              channel.notify_resolved ? t("notif.row.resolved") : null,
              channel.quiet_from && channel.quiet_to ? t("notif.row.quiet", { from: channel.quiet_from, to: channel.quiet_to }) : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        {channel.quiet_pending > 0 && (
          <span className="rounded-md bg-warning-soft px-2 py-0.5 text-xs text-warning" title={t("notif.pending.hint")}>
            {t("notif.pending", { n: channel.quiet_pending })}
          </span>
        )}
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

/** Ustawienia → Powiadomienia: webhook, ntfy albo e-mail – alerty także wtedy, gdy panel nie jest otwarty. */
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
  const timezone = list[0]?.timezone ?? t("notif.quiet.tzUnknown");

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

      {form && <ChannelForm channel={form.channel} timezone={timezone} onClose={() => setForm(null)} />}
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
