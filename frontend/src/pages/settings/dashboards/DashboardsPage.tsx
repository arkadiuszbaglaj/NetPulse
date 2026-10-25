import { IconLayoutDashboard, IconLock, IconPlus, IconWorld } from "@tabler/icons-react";
import { useState } from "react";
import { Link } from "react-router";
import { Dialog } from "../../../components/Dialog";
import { Button, Card, ErrorNote, Field, PageHeader } from "../../../components/ui";
import { t } from "../../../i18n";
import { ApiError } from "../../../lib/api";
import { useDashboardMutations, useDashboards, type DashboardInfo } from "../../../lib/dashboards";
import { formatDateTime } from "../../../lib/format";
import { DashboardWizard } from "./DashboardWizard";
import { ShareFields, ShareLink, draftFrom, shareErrors, sharePayload, type ShareDraft } from "./ShareFields";

const errorText = (err: unknown) => (err instanceof ApiError ? err.message : t("auth.error.generic"));

function ShareDialog({ info, onClose }: { info: DashboardInfo; onClose: () => void }) {
  const { share, rotate } = useDashboardMutations();
  const [draft, setDraft] = useState<ShareDraft>(() => draftFrom(info));
  const [current, setCurrent] = useState(info);
  const [saved, setSaved] = useState(false);
  const invalid = Object.values(shareErrors(draft)).some(Boolean);
  const save = () =>
    share.mutate(
      { id: info.id, body: sharePayload(draft) },
      {
        onSuccess: (next) => {
          setCurrent(next);
          setDraft(draftFrom(next));
          setSaved(true);
        },
      },
    );
  return (
    <Dialog
      title={t("share.title", { name: info.name })}
      onClose={onClose}
      footer={
        <>
          {current.public && (
            <Button className="mr-auto" disabled={rotate.isPending} onClick={() => rotate.mutate(info.id, { onSuccess: setCurrent })}>
              {t("share.rotate")}
            </Button>
          )}
          <Button onClick={onClose}>{t("common.close")}</Button>
          <Button variant="primary" disabled={share.isPending || invalid} onClick={save}>
            {share.isPending ? t("common.saving") : t("common.save")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {current.public && <ShareLink info={current} />}
        <ShareFields
          draft={draft}
          hasPin={current.public?.has_pin}
          onChange={(d) => {
            setDraft(d);
            setSaved(false);
          }}
        />
        {saved && (
          <p role="status" className="text-sm text-success">
            {t(current.public ? "share.saved.public" : "share.saved.private")}
          </p>
        )}
        {share.error && <ErrorNote>{errorText(share.error)}</ErrorNote>}
        {rotate.isSuccess && <p className="text-xs text-text-2">{t("share.rotated")}</p>}
      </div>
    </Dialog>
  );
}

function RenameDialog({ info, onClose }: { info: DashboardInfo; onClose: () => void }) {
  const { rename } = useDashboardMutations();
  const [name, setName] = useState(info.name);
  return (
    <Dialog
      title={t("dashboards.rename")}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" disabled={!name.trim() || rename.isPending} onClick={() => rename.mutate({ id: info.id, name: name.trim() }, { onSuccess: onClose })}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <Field id="rename-dashboard" label={t("dashboards.name")} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
      {rename.error && <ErrorNote>{errorText(rename.error)}</ErrorNote>}
    </Dialog>
  );
}

function DeleteDialog({ info, onClose }: { info: DashboardInfo; onClose: () => void }) {
  const { remove } = useDashboardMutations();
  return (
    <Dialog
      title={t("dashboards.delete.title", { name: info.name })}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="danger" disabled={remove.isPending} onClick={() => remove.mutate(info.id, { onSuccess: onClose })}>
            {t("common.delete")}
          </Button>
        </>
      }
    >
      <p className="text-sm text-text-2">{t(info.public ? "dashboards.delete.bodyPublic" : "dashboards.delete.body")}</p>
    </Dialog>
  );
}

type Open = { kind: "share" | "rename" | "delete"; info: DashboardInfo } | { kind: "wizard" } | null;

function DashboardRow({ info, onOpen }: { info: DashboardInfo; onOpen: (o: Open) => void }) {
  const { makeDefault } = useDashboardMutations();
  const p = info.public;
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3">
      <IconLayoutDashboard size={22} aria-hidden="true" className="shrink-0 text-text-2" />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
          <Link to={info.is_default ? "/" : `/dashboards/${info.id}`} className="hover:text-accent hover:underline">
            {info.name}
          </Link>
          {info.is_default && <span className="rounded-md bg-accent-soft px-1.5 py-0.5 text-xs text-accent">{t("dashboards.default")}</span>}
          <span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs ${p ? (p.expired ? "bg-danger-soft text-danger" : "bg-success-soft text-success") : "bg-surface-2 text-text-2"}`}>
            {p ? <IconWorld size={12} aria-hidden="true" /> : <IconLock size={12} aria-hidden="true" />}
            {t(p ? (p.expired ? "share.expiredBadge" : "share.public") : "share.private")}
            {p?.has_pin && ` · ${t("share.pinBadge")}`}
          </span>
        </p>
        <p className="text-xs text-text-2">
          {t("dashboards.row", { n: info.widgets, updated: formatDateTime(info.updated_at) })}
          {p?.expires_at && ` · ${t("share.until", { date: formatDateTime(p.expires_at) })}`}
        </p>
      </div>
      <div className="flex flex-wrap gap-1">
        <Button variant="ghost" onClick={() => onOpen({ kind: "share", info })}>
          {t("dashboards.share")}
        </Button>
        {!info.is_default && (
          <Button variant="ghost" disabled={makeDefault.isPending} onClick={() => makeDefault.mutate(info.id)}>
            {t("dashboards.makeDefault")}
          </Button>
        )}
        <Button variant="ghost" onClick={() => onOpen({ kind: "rename", info })}>
          {t("dashboards.rename")}
        </Button>
        <Button variant="ghost" onClick={() => onOpen({ kind: "delete", info })}>
          {t("common.delete")}
        </Button>
      </div>
    </li>
  );
}

/** Ustawienia → Dashboardy: własne pulpity (prywatne i publiczne), kreator nowego pulpitu i udostępnianie. */
export function DashboardsPage() {
  const { data, isLoading, isError } = useDashboards();
  const [open, setOpen] = useState<Open>(null);
  const close = () => setOpen(null);
  const list = data ?? [];
  return (
    <>
      <PageHeader title={t("dashboards.title")}>
        <Button variant="primary" onClick={() => setOpen({ kind: "wizard" })}>
          <IconPlus size={16} aria-hidden="true" />
          {t("dashboards.new")}
        </Button>
      </PageHeader>
      <p className="mb-4 max-w-prose text-sm text-text-2">{t("dashboards.intro")}</p>
      {isError && <ErrorNote>{t("dashboards.loadError")}</ErrorNote>}
      {!isLoading && !isError && list.length === 0 && (
        <Card className="p-6">
          <p className="text-sm text-text-2">{t("dashboards.empty")}</p>
        </Card>
      )}
      {list.length > 0 && (
        <Card>
          <ul className="divide-y divide-border">
            {list.map((d) => (
              <DashboardRow key={d.id} info={d} onOpen={setOpen} />
            ))}
          </ul>
        </Card>
      )}
      {open?.kind === "wizard" && <DashboardWizard onClose={close} />}
      {open?.kind === "share" && <ShareDialog info={open.info} onClose={close} />}
      {open?.kind === "rename" && <RenameDialog info={open.info} onClose={close} />}
      {open?.kind === "delete" && <DeleteDialog info={open.info} onClose={close} />}
    </>
  );
}
