import { IconCopy, IconDownload, IconShieldCheck, IconShieldOff } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { AUTH_KEY } from "../auth/AuthProvider";
import { t } from "../i18n";
import { ApiError, get, post } from "../lib/api";
import { Button, Card, ErrorNote, Field, SuccessNote } from "./ui";

/** Logowanie dwuskładnikowe własnego konta (od 0.63.0, backend: api/auth_routes.py `/api/auth/totp*`). */
export interface TotpStatus {
  enabled: boolean;
  pending: boolean;
  recovery_left: number;
}

interface TotpSetup {
  secret: string;
  uri: string;
  qr_svg: string;
}

export const TOTP_KEY = ["auth", "totp"] as const;
const errorMessage = (err: unknown) => (err instanceof ApiError ? err.message : t("auth.error.generic"));

/** Sekret w grupach po 4 znaki – łatwiej przepisać do aplikacji. */
export const groupSecret = (s: string) => s.replace(/(.{4})/g, "$1 ").trim();

function RecoveryCodesView({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const text = codes.join("\n");
  const fileUrl = `data:text/plain;charset=utf-8,${encodeURIComponent(`${t("tfa.codes.file")}\n\n${text}\n`)}`;
  return (
    <div className="flex flex-col gap-3">
      <SuccessNote>{t("tfa.codes.title")}</SuccessNote>
      <p className="text-sm text-text-2">{t("tfa.codes.body")}</p>
      <ul aria-label={t("tfa.codes.list")} className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-lg bg-surface-2 p-3 font-mono text-sm">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button
          onClick={() => {
            void navigator.clipboard?.writeText(text).then(() => setCopied(true));
          }}
        >
          <IconCopy size={18} aria-hidden="true" />
          {copied ? t("tfa.codes.copied") : t("tfa.codes.copy")}
        </Button>
        <a
          href={fileUrl}
          download="netpulse-kody-zapasowe.txt"
          className="inline-flex items-center gap-2 rounded-[10px] border border-border-strong bg-surface px-3.5 py-2 text-sm font-medium text-text hover:bg-surface-2"
        >
          <IconDownload size={18} aria-hidden="true" />
          {t("tfa.codes.download")}
        </a>
        <Button variant="primary" className="ml-auto" onClick={onDone}>
          {t("tfa.codes.done")}
        </Button>
      </div>
    </div>
  );
}

/** Hasło + kod (wyłączenie, nowe kody zapasowe). */
function ConfirmForm({ submitLabel, danger, busy, error, onSubmit, onCancel }: {
  submitLabel: string;
  danger?: boolean;
  busy: boolean;
  error: unknown;
  onSubmit: (password: string, code: string) => void;
  onCancel: () => void;
}) {
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        onSubmit(password, code.trim());
      }}
    >
      <Field id="tfa-confirm-password" label={t("tfa.password")} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <Field id="tfa-confirm-code" label={t("auth.code")} autoComplete="one-time-code" maxLength={32} hint={t("auth.code.hint")} value={code} onChange={(e) => setCode(e.target.value)} />
      {error ? <ErrorNote>{errorMessage(error)}</ErrorNote> : null}
      <div className="flex gap-2">
        <Button onClick={onCancel}>{t("common.cancel")}</Button>
        <Button type="submit" variant={danger ? "danger" : "primary"} disabled={busy || !password || !code.trim()}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

export function TwoFactorCard() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: TOTP_KEY, queryFn: () => get<TotpStatus>("/api/auth/totp") });
  const [step, setStep] = useState<"idle" | "password" | "scan" | "codes" | "disable" | "regenerate">("idle");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [setupData, setSetupData] = useState<TotpSetup | null>(null);
  const [codes, setCodes] = useState<string[]>([]);

  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: TOTP_KEY }), qc.invalidateQueries({ queryKey: AUTH_KEY })]);
  const reset = () => {
    setStep("idle");
    setPassword("");
    setCode("");
    setSetupData(null);
  };

  const begin = useMutation({
    mutationFn: () => post<TotpSetup>("/api/auth/totp/setup", { password }),
    onSuccess: (d) => {
      setSetupData(d);
      setPassword("");
      setStep("scan");
    },
  });
  const enable = useMutation({
    mutationFn: () => post<{ recovery_codes: string[] }>("/api/auth/totp/enable", { code: code.trim() }),
    onSuccess: (d) => {
      setCodes(d.recovery_codes);
      setStep("codes");
      void qc.invalidateQueries({ queryKey: TOTP_KEY });
    },
  });
  const disable = useMutation({
    mutationFn: (v: { password: string; code: string }) => post<TotpStatus>("/api/auth/totp/disable", v),
    onSuccess: async () => {
      reset();
      await refresh();
    },
  });
  const regenerate = useMutation({
    mutationFn: (v: { password: string; code: string }) => post<{ recovery_codes: string[] }>("/api/auth/totp/recovery", v),
    onSuccess: (d) => {
      setCodes(d.recovery_codes);
      setStep("codes");
      void qc.invalidateQueries({ queryKey: TOTP_KEY });
    },
  });

  if (!data) return null;

  return (
    <Card className="max-w-md p-5">
      <div className="mb-3 flex items-center gap-2">
        {data.enabled ? (
          <IconShieldCheck size={20} aria-hidden="true" className="text-success" />
        ) : (
          <IconShieldOff size={20} aria-hidden="true" className="text-text-2" />
        )}
        <h2 className="text-base font-medium">{t("tfa.title")}</h2>
        <span className={`ml-auto rounded-md px-2 py-0.5 text-xs ${data.enabled ? "bg-success-soft text-success" : "bg-surface-2 text-text-2"}`}>
          {data.enabled ? t("tfa.on") : t("tfa.off")}
        </span>
      </div>

      {step === "codes" && (
        <RecoveryCodesView
          codes={codes}
          onDone={() => {
            setCodes([]);
            reset();
            void refresh();
          }}
        />
      )}

      {step === "idle" && !data.enabled && (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-text-2">{t("tfa.intro")}</p>
          <Button variant="primary" className="self-start" onClick={() => setStep("password")}>
            {t("tfa.enable")}
          </Button>
        </div>
      )}

      {step === "password" && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            begin.mutate();
          }}
        >
          <Field id="tfa-password" label={t("tfa.password")} type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
          {begin.isError && <ErrorNote>{errorMessage(begin.error)}</ErrorNote>}
          <div className="flex gap-2">
            <Button onClick={reset}>{t("common.cancel")}</Button>
            <Button type="submit" variant="primary" disabled={begin.isPending || !password}>
              {t("tfa.next")}
            </Button>
          </div>
        </form>
      )}

      {step === "scan" && setupData && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            enable.mutate();
          }}
        >
          <p className="text-sm text-text-2">{t("tfa.scan")}</p>
          <img
            src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(setupData.qr_svg)}`}
            alt={t("tfa.qr")}
            className="size-48 self-center rounded-lg bg-white p-2"
          />
          <p className="text-xs text-text-2">
            {t("tfa.manual")} <span className="select-all break-all font-mono text-text">{groupSecret(setupData.secret)}</span>
          </p>
          <Field
            id="tfa-code"
            label={t("tfa.code")}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={8}
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          {enable.isError && <ErrorNote>{errorMessage(enable.error)}</ErrorNote>}
          <div className="flex gap-2">
            <Button onClick={reset}>{t("common.cancel")}</Button>
            <Button type="submit" variant="primary" disabled={enable.isPending || code.trim().length < 6}>
              {t("tfa.confirm")}
            </Button>
          </div>
        </form>
      )}

      {step === "idle" && data.enabled && (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-text-2">{t("tfa.enabledInfo", { left: data.recovery_left })}</p>
          {data.recovery_left <= 3 && <ErrorNote>{t("tfa.fewCodes")}</ErrorNote>}
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => {
                regenerate.reset();
                setStep("regenerate");
              }}
            >
              {t("tfa.regenerate")}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                disable.reset();
                setStep("disable");
              }}
            >
              {t("tfa.disable")}
            </Button>
          </div>
        </div>
      )}

      {step === "disable" && (
        <ConfirmForm
          danger
          submitLabel={t("tfa.disable")}
          busy={disable.isPending}
          error={disable.error}
          onSubmit={(password, code) => disable.mutate({ password, code })}
          onCancel={reset}
        />
      )}
      {step === "regenerate" && (
        <ConfirmForm
          submitLabel={t("tfa.regenerate")}
          busy={regenerate.isPending}
          error={regenerate.error}
          onSubmit={(password, code) => regenerate.mutate({ password, code })}
          onCancel={reset}
        />
      )}
    </Card>
  );
}
