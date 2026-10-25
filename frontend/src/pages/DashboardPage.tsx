import {
  IconArrowLeft,
  IconArrowRight,
  IconGripVertical,
  IconPencil,
  IconPlus,
  IconTrash,
  IconWand,
} from "@tabler/icons-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Dialog } from "../components/Dialog";
import { RangePicker } from "../components/RangePicker";
import { WIDGET_TYPES, WidgetView, widgetTitle } from "../components/widgets/registry";
import { WidgetEditDialog } from "../components/widgets/WidgetEditDialog";
import { Button, Card, ErrorNote, PageHeader } from "../components/ui";
import { t } from "../i18n";
import {
  GRID_WIDTHS,
  MAX_WIDGETS,
  addWidget,
  dropOn,
  newWidget,
  removeWidget,
  replaceWidget,
  resizeWidget,
  sameLayout,
  shiftWidget,
  type DashboardLayout,
  type GridWidth,
  type Widget,
  type WidgetType,
} from "../lib/layout";
import { useDashboards } from "../lib/dashboards";
import { useDashboardLayout, useResetLayout, useSaveLayout } from "../lib/layoutApi";
import { useDashboardSummary, useDevices } from "../lib/queries";

// Pełne nazwy klas, żeby Tailwind je znalazł (od `lg` układ 12-kolumnowy, niżej jedna kolumna)
export const COL_SPAN: Record<GridWidth, string> = {
  3: "lg:col-span-3",
  4: "lg:col-span-4",
  6: "lg:col-span-6",
  8: "lg:col-span-8",
  12: "lg:col-span-12",
};

function IconButton({ label, onClick, disabled, danger, children }: { label: string; onClick: () => void; disabled?: boolean; danger?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={`flex size-8 items-center justify-center rounded-lg text-text-2 hover:bg-surface-2 disabled:opacity-40 ${
        danger ? "hover:text-danger" : "hover:text-text"
      }`}
    >
      {children}
    </button>
  );
}

/** Pasek narzędzi widgetu w trybie edycji: przeciąganie, kolejność, szerokość, edycja, usuwanie. */
function EditBar({
  widget,
  index,
  count,
  onShift,
  onResize,
  onEdit,
  onRemove,
  onDragStart,
}: {
  widget: Widget;
  index: number;
  count: number;
  onShift: (d: -1 | 1) => void;
  onResize: (w: GridWidth) => void;
  onEdit: () => void;
  onRemove: () => void;
  onDragStart: (e: React.DragEvent) => void;
}) {
  const name = widgetTitle(widget);
  return (
    <div className="mb-1 flex flex-wrap items-center gap-1 rounded-lg border border-dashed border-border-strong bg-surface-2 px-1.5 py-1">
      <span
        draggable
        onDragStart={onDragStart}
        aria-label={t("widget.drag", { name })}
        title={t("widget.drag", { name })}
        className="flex size-8 cursor-grab items-center justify-center text-muted active:cursor-grabbing"
      >
        <IconGripVertical size={18} aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1 truncate text-xs font-medium">{name}</span>
      <IconButton label={t("widget.move.earlier", { name })} onClick={() => onShift(-1)} disabled={index === 0}>
        <IconArrowLeft size={16} aria-hidden="true" />
      </IconButton>
      <IconButton label={t("widget.move.later", { name })} onClick={() => onShift(1)} disabled={index === count - 1}>
        <IconArrowRight size={16} aria-hidden="true" />
      </IconButton>
      <select
        aria-label={t("widget.width", { name })}
        value={widget.w}
        onChange={(e) => onResize(Number(e.target.value) as GridWidth)}
        className="hidden h-8 rounded-lg border border-border bg-surface px-1.5 text-xs lg:block"
      >
        {GRID_WIDTHS.map((w) => (
          <option key={w} value={w}>
            {t(`widget.width.${w}` as const)}
          </option>
        ))}
      </select>
      <IconButton label={t("widget.edit", { name })} onClick={onEdit}>
        <IconPencil size={16} aria-hidden="true" />
      </IconButton>
      <IconButton label={t("widget.remove", { name })} onClick={onRemove} danger>
        <IconTrash size={16} aria-hidden="true" />
      </IconButton>
    </div>
  );
}

function AddWidgetDialog({ onPick, onClose }: { onPick: (type: WidgetType) => void; onClose: () => void }) {
  return (
    <Dialog title={t("widget.add.title")} size="sm" onClose={onClose}>
      <ul className="flex flex-col gap-2">
        {WIDGET_TYPES.map(({ type, label, description, icon: Icon }) => (
          <li key={type}>
            <button
              type="button"
              onClick={() => onPick(type)}
              className="flex w-full items-start gap-3 rounded-xl border border-border p-3 text-left hover:bg-surface-2"
            >
              <Icon size={22} aria-hidden="true" className="mt-0.5 shrink-0 text-accent" />
              <span>
                <span className="block text-sm font-medium">{t(label)}</span>
                <span className="block text-xs text-text-2">{t(description)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

function ConfirmDialog({ title, body, go, keep, onGo, onKeep, danger }: { title: string; body: string; go: string; keep: string; onGo: () => void; onKeep: () => void; danger?: boolean }) {
  return (
    <Dialog
      title={title}
      size="sm"
      onClose={onKeep}
      footer={
        <>
          <Button variant="ghost" onClick={onKeep}>
            {keep}
          </Button>
          <Button variant={danger ? "danger" : "primary"} onClick={onGo}>
            {go}
          </Button>
        </>
      }
    >
      <p className="text-sm text-text-2">{body}</p>
    </Dialog>
  );
}

/** Przełącznik pulpitów: „/” (domyślny) i pozostałe zapisane pulpity. Widoczny, gdy jest więcej niż jeden. */
function DashboardSwitcher({ currentId }: { currentId?: number }) {
  const navigate = useNavigate();
  const { data } = useDashboards();
  const others = (data ?? []).filter((d) => !d.is_default);
  if (others.length === 0) return null;
  const main = (data ?? []).find((d) => d.is_default);
  return (
    <select
      aria-label={t("dash.switch")}
      value={currentId === undefined || currentId === main?.id ? "" : String(currentId)}
      onChange={(e) => navigate(e.target.value ? `/dashboards/${e.target.value}` : "/")}
      className="h-9 max-w-56 rounded-lg border border-border-strong bg-surface px-2 text-sm"
    >
      <option value="">{main?.name ?? t("dash.main")}</option>
      {others.map((d) => (
        <option key={d.id} value={d.id}>
          {d.name}
        </option>
      ))}
    </select>
  );
}

/** Pulpit: widgety z układu zapisanego na koncie (albo domyślnego); „Edytuj pulpit” włącza tryb edycji.
 * Pod /dashboards/<id> – wybrany pulpit z listy (Ustawienia → Dashboardy). */
export function DashboardPage() {
  const param = useParams().dashboardId;
  const dashboardId = param !== undefined ? Number(param) : undefined;
  const { layout: saved, isCustom, name, missing } = useDashboardLayout(dashboardId);
  const save = useSaveLayout(dashboardId);
  const reset = useResetLayout();
  const summary = useDashboardSummary();
  const devices = useDevices();

  const [draft, setDraft] = useState<DashboardLayout | null>(null); // null = tryb podglądu
  const [dragId, setDragId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ widget: Widget; isNew: boolean } | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirm, setConfirm] = useState<"discard" | "reset" | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);

  const edit = draft !== null;
  const layout = draft ?? saved;
  const noDevices = dashboardId === undefined && !devices.isLoading && !devices.isError && (devices.data?.length ?? 0) === 0;
  const dirty = draft !== null && !sameLayout(draft, saved);

  const update = (fn: (l: DashboardLayout) => DashboardLayout) => setDraft((d) => (d ? fn(d) : d));

  const startEdit = () => {
    setSaveFailed(false);
    setDraft(saved);
  };
  const cancel = () => (dirty ? setConfirm("discard") : setDraft(null));
  const commit = () => {
    if (!draft) return;
    setSaveFailed(false);
    save.mutate(draft, {
      onSuccess: () => setDraft(null),
      onError: () => setSaveFailed(true),
    });
  };
  const doReset = () => {
    setConfirm(null);
    reset.mutate(undefined, { onSuccess: () => setDraft(null), onError: () => setSaveFailed(true) });
  };

  const atLimit = (draft?.widgets.length ?? 0) >= MAX_WIDGETS;

  return (
    <>
      <PageHeader title={name ?? t("dash.title")}>
        <div className="flex flex-wrap items-center gap-2">
          {!edit && <DashboardSwitcher currentId={dashboardId} />}
          {!edit && <RangePicker />}
          {!edit ? (
            <Button onClick={startEdit}>
              <IconPencil size={16} aria-hidden="true" />
              {t("dash.edit")}
            </Button>
          ) : (
            <>
              <Button onClick={() => setAdding(true)} disabled={atLimit} title={atLimit ? t("dash.edit.limit", { max: MAX_WIDGETS }) : undefined}>
                <IconPlus size={16} aria-hidden="true" />
                {t("dash.edit.add")}
              </Button>
              {isCustom && dashboardId === undefined && (
                <Button variant="ghost" onClick={() => setConfirm("reset")}>
                  {t("dash.edit.reset")}
                </Button>
              )}
              <Button variant="ghost" onClick={cancel}>
                {t("dash.edit.cancel")}
              </Button>
              <Button variant="primary" onClick={commit} disabled={save.isPending || !dirty}>
                {save.isPending ? t("dash.edit.saving") : t("dash.edit.save")}
              </Button>
            </>
          )}
        </div>
      </PageHeader>

      {edit && (
        <p role="status" className="mb-4 rounded-lg bg-accent-soft px-3 py-2 text-sm text-accent">
          {t("dash.edit.banner")}
        </p>
      )}
      {missing && <ErrorNote>{t("dash.missing")}</ErrorNote>}
      {saveFailed && <ErrorNote>{t("dash.edit.saveError")}</ErrorNote>}
      {(summary.isError || devices.isError) && !summary.data && !edit && <ErrorNote>{t("dash.error")}</ErrorNote>}

      {noDevices && !edit && (
        <Card className="mb-4 p-6">
          <h2 className="text-base font-medium">{t("dash.empty.title")}</h2>
          <p className="mt-1 text-sm text-text-2">{t("dash.empty.wizard")}</p>
          <Link
            to="/setup"
            className="mt-3 inline-flex items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-on-accent hover:bg-accent-hover"
          >
            <IconWand size={16} aria-hidden="true" />
            {t("dash.empty.start")}
          </Link>
          <p className="mt-4 text-sm text-text-2">{t("dash.empty.body")}</p>
          <code className="mt-2 block overflow-x-auto rounded-lg bg-surface-2 px-3 py-2 font-mono text-xs">
            netpulse device add &quot;UCG Ultra&quot; 192.168.1.1 --community public
          </code>
        </Card>
      )}

      {layout.widgets.length === 0 ? (
        <p className="py-10 text-center text-sm text-text-2">{t(edit ? "dash.edit.empty" : "dash.empty.layout")}</p>
      ) : (
        !(noDevices && !edit) && (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-12">
            {layout.widgets.map((widget, index) => (
              <div
                key={widget.id}
                className={`min-w-0 ${COL_SPAN[widget.w]} ${dragId === widget.id ? "opacity-50" : ""}`}
                onDragOver={edit && dragId ? (e) => e.preventDefault() : undefined}
                onDrop={
                  edit && dragId
                    ? (e) => {
                        e.preventDefault();
                        update((l) => dropOn(l, dragId, widget.id));
                        setDragId(null);
                      }
                    : undefined
                }
              >
                {edit && (
                  <EditBar
                    widget={widget}
                    index={index}
                    count={layout.widgets.length}
                    onShift={(d) => update((l) => shiftWidget(l, widget.id, d))}
                    onResize={(w) => update((l) => resizeWidget(l, widget.id, w))}
                    onEdit={() => setEditing({ widget, isNew: false })}
                    onRemove={() => update((l) => removeWidget(l, widget.id))}
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/plain", widget.id);
                      e.dataTransfer.effectAllowed = "move";
                      setDragId(widget.id);
                    }}
                  />
                )}
                <div onDragEnd={() => setDragId(null)}>
                  <WidgetView widget={widget} />
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {adding && (
        <AddWidgetDialog
          onClose={() => setAdding(false)}
          onPick={(type) => {
            setAdding(false);
            setEditing({ widget: newWidget(type), isNew: true });
          }}
        />
      )}
      {editing && (
        <WidgetEditDialog
          widget={editing.widget}
          isNew={editing.isNew}
          onClose={() => setEditing(null)}
          onSave={(widget) => {
            update((l) => (editing.isNew ? addWidget(l, widget) : replaceWidget(l, widget)));
            setEditing(null);
          }}
        />
      )}
      {confirm === "discard" && (
        <ConfirmDialog
          title={t("dash.edit.discard.title")}
          body={t("dash.edit.discard.body")}
          go={t("dash.edit.discard.go")}
          keep={t("dash.edit.keep")}
          danger
          onKeep={() => setConfirm(null)}
          onGo={() => {
            setConfirm(null);
            setDraft(null);
          }}
        />
      )}
      {confirm === "reset" && (
        <ConfirmDialog
          title={t("dash.edit.reset.title")}
          body={t("dash.edit.reset.body")}
          go={t("dash.edit.reset.go")}
          keep={t("common.cancel")}
          onKeep={() => setConfirm(null)}
          onGo={doReset}
        />
      )}
    </>
  );
}
