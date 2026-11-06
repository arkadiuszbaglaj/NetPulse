import { useState } from "react";
import { Button, Card, ErrorNote, PageHeader } from "../../components/ui";
import { t, type TextKey } from "../../i18n";
import { auditFailed, auditLabel, useAudit, type AuditKind } from "../../lib/audit";
import { formatDateTime } from "../../lib/format";

const KINDS: { kind: AuditKind; label: TextKey }[] = [
  { kind: "all", label: "audit.kind.all" },
  { kind: "changes", label: "audit.kind.changes" },
  { kind: "auth", label: "audit.kind.auth" },
  { kind: "denied", label: "audit.kind.denied" },
];
const PAGE = 50;

/** Ustawienia → Dziennik zdarzeń (tylko administrator): logowania i zmiany konfiguracji, bez treści żądań. */
export function AuditPage() {
  const [kind, setKind] = useState<AuditKind>("all");
  const [q, setQ] = useState("");
  const [offset, setOffset] = useState(0);
  const { data, isError, isFetching } = useAudit(kind, q, offset, PAGE);
  const items = data?.items ?? [];
  const total = data?.total ?? 0;

  return (
    <>
      <PageHeader title={t("nav.settings.audit")} />
      <p className="mb-4 max-w-prose text-sm text-text-2">{t("audit.intro")}</p>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div role="group" aria-label={t("audit.filter")} className="flex flex-wrap gap-1">
          {KINDS.map((k) => (
            <button
              key={k.kind}
              type="button"
              aria-pressed={kind === k.kind}
              className={`rounded-lg px-3 py-1.5 text-sm ${kind === k.kind ? "bg-accent-soft text-accent-text" : "text-text-2 hover:bg-surface-2"}`}
              onClick={() => {
                setKind(k.kind);
                setOffset(0);
              }}
            >
              {t(k.label)}
            </button>
          ))}
        </div>
        <input
          type="search"
          aria-label={t("audit.search")}
          placeholder={t("audit.search")}
          value={q}
          maxLength={64}
          className="ml-auto h-9 w-full rounded-[10px] border border-border-strong bg-surface px-3 text-sm sm:w-64"
          onChange={(e) => {
            setQ(e.target.value);
            setOffset(0);
          }}
        />
      </div>

      {isError && !data && <ErrorNote>{t("audit.loadError")}</ErrorNote>}
      {data && items.length === 0 && (
        <Card className="p-6">
          <p className="text-sm text-text-2">{t("audit.empty")}</p>
        </Card>
      )}
      {items.length > 0 && (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">{t("audit.col.time")}</th>
                <th className="px-4 py-2 font-medium">{t("audit.col.user")}</th>
                <th className="px-4 py-2 font-medium">{t("audit.col.action")}</th>
                <th className="px-4 py-2 font-medium">{t("audit.col.ip")}</th>
                <th className="px-4 py-2 font-medium">{t("audit.col.result")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {items.map((e) => {
                const failed = auditFailed(e);
                return (
                  <tr key={e.id}>
                    <td className="whitespace-nowrap px-4 py-2 text-text-2">{formatDateTime(e.time)}</td>
                    <td className="px-4 py-2">{e.username ?? "-"}</td>
                    <td className="px-4 py-2">
                      <span>{auditLabel(e.action)}</span>
                      {(e.target || e.detail) && (
                        <span className="block font-mono text-xs text-muted">{[e.target, e.detail].filter(Boolean).join(" · ")}</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 font-mono text-xs text-text-2">{e.ip ?? "-"}</td>
                    <td className="whitespace-nowrap px-4 py-2">
                      <span className={`rounded-md px-2 py-0.5 text-xs ${failed ? "bg-danger-soft text-danger" : "bg-success-soft text-success"}`}>
                        {failed ? (e.status === 403 ? t("audit.denied") : t("audit.failed")) : t("audit.ok")}
                        {e.status != null ? ` (${e.status})` : ""}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
      {total > PAGE && (
        <div className="mt-3 flex items-center justify-end gap-2 text-sm text-text-2">
          <span>{t("audit.range", { from: offset + 1, to: Math.min(offset + PAGE, total), total })}</span>
          <Button disabled={offset === 0 || isFetching} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
            {t("audit.prev")}
          </Button>
          <Button disabled={offset + PAGE >= total || isFetching} onClick={() => setOffset(offset + PAGE)}>
            {t("audit.next")}
          </Button>
        </div>
      )}
    </>
  );
}
