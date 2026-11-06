import { IconDownload, IconLock, IconLockOpen, IconX } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { t } from "../i18n";
import { ApiError, get, put } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { useCan } from "../lib/roles";
import { Button, Card, ErrorNote } from "./ui";

/** Stan certyfikatu HTTPS (od 0.62.0, backend: api/tls.py). */
export interface TlsStatus {
  available: boolean;
  mode: "local" | "custom" | "none";
  https_port: number | null;
  names: string[];
  requested: string[];
  not_after: string | null;
  issuer: string | null;
  ca_fingerprint: string | null;
  host: string;
  host_covered: boolean;
  https: boolean;
}

export const TLS_KEY = ["system", "tls"] as const;
export const CA_URL = "/api/system/tls/ca.pem";

/** Adres panelu przez HTTPS pod tym samym adresem (IPv6 w nawiasach). */
export function httpsUrl(host: string, port: number, path = "/"): string {
  const h = host.includes(":") ? `[${host}]` : host;
  return `https://${h}${port === 443 ? "" : `:${port}`}${path}`;
}

const pending = (s: TlsStatus | undefined) => !!s && s.mode === "local" && s.requested.some((n) => !s.names.includes(n));

export function HttpsCard() {
  const qc = useQueryClient();
  const admin = useCan("admin");
  const { data, isError } = useQuery({
    queryKey: TLS_KEY,
    queryFn: () => get<TlsStatus>("/api/system/tls"),
    // Po dopisaniu adresu proxy wystawia certyfikat w ciągu ~30 s – odświeżamy, aż się pojawi
    refetchInterval: (q) => (pending(q.state.data) ? 5000 : false),
  });
  const [name, setName] = useState("");
  const save = useMutation({
    mutationFn: (names: string[]) => put<TlsStatus>("/api/system/tls/names", { names }),
    onSuccess: (s) => {
      qc.setQueryData(TLS_KEY, s);
      setName("");
    },
  });

  if (isError) return <ErrorNote>{t("tls.error")}</ErrorNote>;
  if (!data) return null;
  if (!data.available) {
    return (
      <Card className="p-4">
        <p className="text-sm text-text-2">{t("tls.unavailable")}</p>
      </Card>
    );
  }

  const local = data.mode === "local";
  const add = (n: string) => save.mutate([...data.requested, n.trim()]);
  const link = data.https_port ? httpsUrl(data.host, data.https_port, window.location.pathname) : null;

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center gap-3">
        {data.https ? (
          <span className="flex items-center gap-1.5 rounded-md bg-success-soft px-2 py-0.5 text-sm text-success">
            <IconLock size={16} aria-hidden="true" />
            {t("tls.secure")}
          </span>
        ) : (
          <span className="flex items-center gap-1.5 rounded-md bg-warning-soft px-2 py-0.5 text-sm text-warning">
            <IconLockOpen size={16} aria-hidden="true" />
            {t("tls.plain")}
          </span>
        )}
        {!data.https && link && (
          <a className="text-sm font-medium text-accent-text underline-offset-2 hover:underline" href={link}>
            {t("tls.open", { port: data.https_port ?? "" })}
          </a>
        )}
        {local && (
          <a
            href={CA_URL}
            download="netpulse-ca.pem"
            className="ml-auto inline-flex items-center gap-2 rounded-[10px] border border-border-strong bg-surface px-3.5 py-2 text-sm font-medium text-text hover:bg-surface-2"
          >
            <IconDownload size={18} aria-hidden="true" />
            {t("tls.downloadCa")}
          </a>
        )}
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
        <dt className="text-text-2">{t("tls.kind")}</dt>
        <dd>{local ? t("tls.kind.local") : t("tls.kind.custom", { issuer: data.issuer ?? "?" })}</dd>
        <dt className="text-text-2">{t("tls.validUntil")}</dt>
        <dd>{formatDateTime(data.not_after)}</dd>
        <dt className="text-text-2">{t("tls.names")}</dt>
        <dd className="flex flex-wrap gap-1">
          {data.names.map((n) => (
            <span key={n} className="rounded-md bg-surface-2 px-2 py-0.5 font-mono text-xs">
              {n}
            </span>
          ))}
        </dd>
        {data.ca_fingerprint && (
          <>
            <dt className="text-text-2">{t("tls.fingerprint")}</dt>
            <dd className="break-all font-mono text-xs">{data.ca_fingerprint}</dd>
          </>
        )}
      </dl>

      {local && !data.host_covered && data.host && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning">
          <span className="flex-1">{t("tls.notCovered", { host: data.host })}</span>
          {admin && !data.requested.includes(data.host) && (
            <Button disabled={save.isPending} onClick={() => add(data.host)}>
              {t("tls.addHost")}
            </Button>
          )}
        </div>
      )}
      {pending(data) && <p className="text-sm text-text-2">{t("tls.pending")}</p>}

      {local && admin && (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">{t("tls.extra")}</p>
          {data.requested.length > 0 && (
            <ul className="flex flex-wrap gap-1">
              {data.requested.map((n) => (
                <li key={n} className="flex items-center gap-1 rounded-md bg-surface-2 py-0.5 pl-2 pr-1 font-mono text-xs">
                  {n}
                  <button
                    type="button"
                    className="rounded p-0.5 text-text-2 hover:bg-surface hover:text-text"
                    aria-label={t("tls.remove", { name: n })}
                    disabled={save.isPending}
                    onClick={() => save.mutate(data.requested.filter((x) => x !== n))}
                  >
                    <IconX size={14} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) add(name);
            }}
          >
            <input
              aria-label={t("tls.newName")}
              placeholder="netpulse.lan"
              value={name}
              maxLength={253}
              autoCapitalize="none"
              spellCheck={false}
              className="h-9 w-full rounded-[10px] border border-border-strong bg-surface px-3 text-sm sm:w-64"
              onChange={(e) => setName(e.target.value)}
            />
            <Button type="submit" disabled={save.isPending || !name.trim()}>
              {t("tls.add")}
            </Button>
          </form>
          <p className="text-xs text-muted">{t("tls.extra.hint")}</p>
        </div>
      )}
      {save.isError && <ErrorNote>{save.error instanceof ApiError ? save.error.message : t("auth.error.generic")}</ErrorNote>}

      {local && (
        <details className="text-sm">
          <summary className="cursor-pointer font-medium">{t("tls.howto")}</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-text-2">
            <li>{t("tls.howto.windows")}</li>
            <li>{t("tls.howto.mac")}</li>
            <li>{t("tls.howto.linux")}</li>
            <li>{t("tls.howto.firefox")}</li>
            <li>{t("tls.howto.phone")}</li>
          </ul>
        </details>
      )}
    </Card>
  );
}
