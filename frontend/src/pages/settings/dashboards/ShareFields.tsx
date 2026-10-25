import { IconCopy, IconExternalLink, IconLock, IconWorld } from "@tabler/icons-react";
import { useState } from "react";
import { Button, Field, Select } from "../../../components/ui";
import { t } from "../../../i18n";
import {
  DEFAULT_PUBLIC_OPTIONS,
  PUBLIC_REFRESH,
  publicUrl,
  qrUrl,
  type DashboardInfo,
  type PublicOptions,
  type PublicPayload,
  type PublicRefresh,
} from "../../../lib/dashboards";
import { formatRange } from "../../../lib/format";
import { RANGE_OPTIONS, type RangeMinutes } from "../../../lib/refresh";

/** Stan formularza widoczności pulpitu (kreator i okno „Udostępnianie”). */
export interface ShareDraft {
  visibility: "private" | "public";
  options: PublicOptions;
  /** Data wygaśnięcia RRRR-MM-DD albo "" (bez wygaśnięcia) */
  expires: string;
  pin: string;
  clearPin: boolean;
}

export function draftFrom(info?: DashboardInfo): ShareDraft {
  const p = info?.public;
  return {
    visibility: p ? "public" : "private",
    options: p?.options ?? DEFAULT_PUBLIC_OPTIONS,
    expires: p?.expires_at ? p.expires_at.slice(0, 10) : "",
    pin: "",
    clearPin: false,
  };
}

const today = () => new Date().toISOString().slice(0, 10);

/** Błędy formularza: PIN z cyfr (4–12), data wygaśnięcia nie w przeszłości. */
export function shareErrors(d: ShareDraft): { pin?: string; expires?: string } {
  if (d.visibility === "private") return {};
  return {
    pin: d.pin && !/^\d{4,12}$/.test(d.pin) ? t("share.pin.invalid") : undefined,
    expires: d.expires && d.expires < today() ? t("share.expires.past") : undefined,
  };
}

export function sharePayload(d: ShareDraft): PublicPayload {
  if (d.visibility === "private") return { enabled: false };
  return {
    enabled: true,
    // Link działa do końca wybranego dnia (czas lokalny przeglądarki)
    expires_at: d.expires ? new Date(`${d.expires}T23:59:59`).toISOString() : null,
    ...(d.pin ? { pin: d.pin } : {}),
    clear_pin: d.clearPin && !d.pin,
    options: d.options,
  };
}

function Choice({ checked, onSelect, icon: Icon, title, body }: { checked: boolean; onSelect: () => void; icon: typeof IconLock; title: string; body: string }) {
  return (
    <label className={`flex cursor-pointer gap-3 rounded-xl border p-3 ${checked ? "border-accent bg-accent-soft" : "border-border hover:bg-surface-2"}`}>
      <input type="radio" name="visibility" checked={checked} onChange={onSelect} className="mt-1 accent-[var(--accent)]" />
      <Icon size={22} aria-hidden="true" className="mt-0.5 shrink-0 text-accent" />
      <span>
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-text-2">{body}</span>
      </span>
    </label>
  );
}

export function ShareFields({ draft, onChange, hasPin }: { draft: ShareDraft; onChange: (d: ShareDraft) => void; hasPin?: boolean }) {
  const set = (patch: Partial<ShareDraft>) => onChange({ ...draft, ...patch });
  const setOpt = (patch: Partial<PublicOptions>) => onChange({ ...draft, options: { ...draft.options, ...patch } });
  const errors = shareErrors(draft);
  return (
    <div className="flex flex-col gap-3">
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">{t("share.visibility")}</legend>
        <Choice checked={draft.visibility === "private"} onSelect={() => set({ visibility: "private" })} icon={IconLock} title={t("share.private")} body={t("share.private.desc")} />
        <Choice checked={draft.visibility === "public"} onSelect={() => set({ visibility: "public" })} icon={IconWorld} title={t("share.public")} body={t("share.public.desc")} />
      </fieldset>
      {draft.visibility === "public" && (
        <div className="flex flex-col gap-3 rounded-xl border border-border p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Select id="share-refresh" label={t("share.refresh")} value={draft.options.refresh_s} onChange={(e) => setOpt({ refresh_s: Number(e.target.value) as PublicRefresh })}>
              {PUBLIC_REFRESH.map((s) => (
                <option key={s} value={s}>
                  {t("share.refresh.every", { s })}
                </option>
              ))}
            </Select>
            <Select id="share-range" label={t("share.range")} value={draft.options.range_min} onChange={(e) => setOpt({ range_min: Number(e.target.value) as RangeMinutes })}>
              {RANGE_OPTIONS.map((m) => (
                <option key={m} value={m}>
                  {formatRange(m)}
                </option>
              ))}
            </Select>
            <Field id="share-expires" type="date" label={t("share.expires")} hint={t("share.expires.hint")} min={today()} value={draft.expires} error={errors.expires} onChange={(e) => set({ expires: e.target.value })} />
            <Field
              id="share-pin"
              label={hasPin ? t("share.pin.change") : t("share.pin")}
              hint={t("share.pin.hint")}
              inputMode="numeric"
              autoComplete="off"
              maxLength={12}
              value={draft.pin}
              error={errors.pin}
              onChange={(e) => set({ pin: e.target.value.trim() })}
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={draft.options.hide_hosts} onChange={(e) => setOpt({ hide_hosts: e.target.checked })} />
            {t("share.hideHosts")}
          </label>
          {hasPin && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={draft.clearPin} onChange={(e) => set({ clearPin: e.target.checked })} />
              {t("share.pin.clear")}
            </label>
          )}
          <p className="text-xs text-text-2">{t("share.security")}</p>
        </div>
      )}
    </div>
  );
}

/** Link do pulpitu publicznego: kopiowanie, otwarcie i kod QR. */
export function ShareLink({ info }: { info: DashboardInfo }) {
  const [copied, setCopied] = useState(false);
  if (!info.public) return null;
  const url = publicUrl(info.public.token);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <label htmlFor={`share-url-${info.id}`} className="text-sm font-medium">
          {t("share.link")}
        </label>
        <input
          id={`share-url-${info.id}`}
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          className="h-10 w-full rounded-lg border border-border-strong bg-surface-2 px-3 font-mono text-xs"
        />
        <div className="flex flex-wrap gap-2">
          <Button onClick={copy}>
            <IconCopy size={16} aria-hidden="true" />
            {copied ? t("share.copied") : t("share.copy")}
          </Button>
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm text-text-2 hover:bg-surface-2 hover:text-text"
          >
            <IconExternalLink size={16} aria-hidden="true" />
            {t("share.open")}
          </a>
        </div>
        {info.public.expired && <p className="text-xs text-danger">{t("share.expired")}</p>}
      </div>
      <img src={`${qrUrl(info.id)}&v=${info.public.token.slice(0, 8)}`} alt={t("share.qr")} width={148} height={148} className="shrink-0 self-center rounded-lg border border-border bg-white p-1" />
    </div>
  );
}
