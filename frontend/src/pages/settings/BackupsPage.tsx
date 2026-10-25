import { IconDatabaseExport, IconDownload, IconRestore, IconTrash, IconUpload } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Dialog } from "../../components/Dialog";
import { Button, Card, ErrorNote, PageHeader, SuccessNote } from "../../components/ui";
import { t, type TextKey } from "../../i18n";
import { ApiError, del, post } from "../../lib/api";
import {
  apiHealthy,
  BACKUPS_KEY,
  downloadUrl,
  uploadBackup,
  useBackups,
  type Backup,
  type BackupKind,
  type BackupsResponse,
} from "../../lib/backups";
import { formatBytes } from "../../lib/format";

const KIND_LABEL: Record<BackupKind, TextKey> = {
  manual: "backups.kind.manual",
  update: "backups.kind.update",
  prerestore: "backups.kind.prerestore",
  upload: "backups.kind.upload",
};
const errorMessage = (err: unknown) => (err instanceof ApiError ? err.message : t("auth.error.generic"));
const iconButton = "flex size-9 items-center justify-center rounded-lg text-text-2 hover:bg-surface-2 hover:text-text disabled:opacity-50";
const formatDate = (iso: string) => new Intl.DateTimeFormat("pl", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));

/** Ekran na czas przywracania: API jest wtedy zatrzymane, więc czekamy, aż wróci, i odświeżamy stronę. */
function RestoreProgress({ onDone }: { onDone: () => void }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    let down = false;
    const timer = window.setInterval(async () => {
      setSeconds((s) => s + 2);
      const ok = await apiHealthy();
      if (!ok) down = true;
      // API wróciło po przerwie (albo przywracanie skończyło się, zanim zdążyło zniknąć)
      if (ok && down) onDone();
    }, 2000);
    const fallback = window.setTimeout(onDone, 180_000);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(fallback);
    };
  }, [onDone]);
  return (
    <Card className="p-6" >
      <div role="status" className="flex flex-col gap-2">
        <h2 className="text-base font-medium">{t("backups.restoring.title")}</h2>
        <p className="max-w-prose text-sm text-text-2">{t("backups.restoring.body")}</p>
        <p className="text-xs text-text-2">{t("backups.restoring.elapsed", { s: seconds })}</p>
      </div>
    </Card>
  );
}

function RestoreResult({ data }: { data: BackupsResponse }) {
  const r = data.restore;
  if (r.state === "ok") return <SuccessNote>{t("backups.restore.ok", { name: r.backup ?? "?", safety: r.safety ?? "?" })}</SuccessNote>;
  if (r.state === "failed") return <ErrorNote>{t("backups.restore.failed", { error: r.error ?? "?" })}</ErrorNote>;
  return null;
}

/** Ustawienia → Kopia zapasowa: kopia na żądanie, pobranie na komputer, przywrócenie. */
export function BackupsPage() {
  const qc = useQueryClient();
  const { data, isLoading, isError, error } = useBackups();
  const [toRestore, setToRestore] = useState<Backup | null>(null);
  const [toDelete, setToDelete] = useState<Backup | null>(null);
  const [restoring, setRestoring] = useState(false);

  const refresh = (payload?: BackupsResponse) => (payload ? qc.setQueryData(BACKUPS_KEY, payload) : qc.invalidateQueries({ queryKey: BACKUPS_KEY }));
  const create = useMutation({ mutationFn: () => post<BackupsResponse>("/api/backups"), onSuccess: refresh });
  const remove = useMutation({
    mutationFn: (name: string) => del(`/api/backups/${encodeURIComponent(name)}`),
    onSuccess: () => {
      setToDelete(null);
      return refresh();
    },
  });
  const restore = useMutation({
    mutationFn: (name: string) => post<BackupsResponse>(`/api/backups/${encodeURIComponent(name)}/restore`),
    onSuccess: () => {
      setToRestore(null);
      setRestoring(true);
    },
  });

  const fileInput = useRef<HTMLInputElement>(null);
  const upload = useMutation({
    mutationFn: (file: File) => {
      if (!file.name.endsWith(".gz")) throw new ApiError(400, t("backups.upload.notGz"));
      return uploadBackup(file);
    },
    onSuccess: refresh,
  });

  const list = data?.backups ?? [];
  const running = restoring || data?.restore.state === "running";
  const busy = create.isPending || upload.isPending || running || !data;

  return (
    <>
      <PageHeader title={t("settings.backups.title")}>
        <input
          ref={fileInput}
          type="file"
          accept=".gz,application/gzip"
          className="hidden"
          aria-label={t("backups.upload")}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = ""; // ten sam plik można wybrać ponownie
            if (file) {
              create.reset();
              upload.mutate(file);
            }
          }}
        />
        {/* Jedna grupa po prawej: najpierw kopia teraz, potem wgranie z komputera */}
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => {
              upload.reset();
              create.mutate();
            }}
          >
            <IconDatabaseExport size={18} aria-hidden="true" />
            {create.isPending ? t("backups.creating") : t("backups.create")}
          </Button>
          <Button disabled={busy} onClick={() => fileInput.current?.click()}>
            <IconUpload size={18} aria-hidden="true" />
            {upload.isPending ? t("backups.uploading") : t("backups.upload")}
          </Button>
        </div>
      </PageHeader>
      <p className="mb-4 max-w-prose text-sm text-text-2">{t("backups.intro")}</p>

      {running ? (
        <RestoreProgress
          onDone={() => {
            // Po przywróceniu sesja i dane mogą być inne – pełne przeładowanie
            window.location.reload();
          }}
        />
      ) : (
        <div className="flex flex-col gap-4">
          {data && <RestoreResult data={data} />}
          {create.isSuccess && <SuccessNote>{t("backups.created")}</SuccessNote>}
          {upload.isPending && <p role="status" className="text-sm text-text-2">{t("backups.uploading.hint")}</p>}
          {upload.isSuccess && <SuccessNote>{t("backups.uploaded")}</SuccessNote>}
          {upload.isError && <ErrorNote>{errorMessage(upload.error)}</ErrorNote>}
          {create.isError && <ErrorNote>{errorMessage(create.error)}</ErrorNote>}
          {isError && <ErrorNote>{errorMessage(error)}</ErrorNote>}
          {!isLoading && data && list.length === 0 && (
            <Card className="p-6">
              <h2 className="text-base font-medium">{t("backups.empty.title")}</h2>
              <p className="mt-1 max-w-prose text-sm text-text-2">{t("backups.empty.body")}</p>
            </Card>
          )}
          {list.length > 0 && (
            <Card>
              <ul className="divide-y divide-border">
                {list.map((b) => (
                  <li key={b.name} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                    <div className="min-w-0 flex-1 basis-56">
                      <p className="truncate text-sm font-medium">{formatDate(b.created_at)}</p>
                      <p className="truncate text-xs text-text-2">
                        {t(KIND_LABEL[b.kind])} · {formatBytes(b.size_bytes)}
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      <a className={iconButton} href={downloadUrl(b.name)} download={b.name} aria-label={`${t("backups.download")}: ${formatDate(b.created_at)}`} title={t("backups.download")}>
                        <IconDownload size={18} aria-hidden="true" />
                      </a>
                      <button type="button" className={iconButton} aria-label={`${t("backups.restore")}: ${formatDate(b.created_at)}`} title={t("backups.restore")} onClick={() => { restore.reset(); setToRestore(b); }}>
                        <IconRestore size={18} aria-hidden="true" />
                      </button>
                      <button type="button" className={iconButton} aria-label={`${t("common.delete")}: ${formatDate(b.created_at)}`} title={t("common.delete")} onClick={() => { remove.reset(); setToDelete(b); }}>
                        <IconTrash size={18} aria-hidden="true" />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <p className="max-w-prose text-xs text-text-2">{t("backups.where")}</p>
          <p className="max-w-prose text-xs text-text-2">{t("backups.key")}</p>
        </div>
      )}

      {toRestore && (
        <Dialog
          title={t("backups.restore.title")}
          onClose={() => setToRestore(null)}
          footer={
            <>
              <Button data-autofocus onClick={() => setToRestore(null)}>
                {t("common.cancel")}
              </Button>
              <Button variant="danger" disabled={restore.isPending} onClick={() => restore.mutate(toRestore.name)}>
                {t("backups.restore.confirm")}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-3 text-sm">
            <p>{t("backups.restore.body", { date: formatDate(toRestore.created_at) })}</p>
            <p className="text-text-2">{t("backups.restore.safety")}</p>
            {restore.isError && <ErrorNote>{errorMessage(restore.error)}</ErrorNote>}
          </div>
        </Dialog>
      )}
      {toDelete && (
        <Dialog
          size="sm"
          title={t("backups.delete.title")}
          onClose={() => setToDelete(null)}
          footer={
            <>
              <Button data-autofocus onClick={() => setToDelete(null)}>
                {t("common.cancel")}
              </Button>
              <Button variant="danger" disabled={remove.isPending} onClick={() => remove.mutate(toDelete.name)}>
                {t("common.delete")}
              </Button>
            </>
          }
        >
          <p className="text-sm">{t("backups.delete.body", { date: formatDate(toDelete.created_at) })}</p>
          {remove.isError && <ErrorNote>{errorMessage(remove.error)}</ErrorNote>}
        </Dialog>
      )}
    </>
  );
}
