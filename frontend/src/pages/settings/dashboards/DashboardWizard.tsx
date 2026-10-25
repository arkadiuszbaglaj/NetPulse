import { IconArrowDown, IconArrowUp, IconPlus, IconTrash } from "@tabler/icons-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { Dialog } from "../../../components/Dialog";
import { Button, ErrorNote, Field, Select } from "../../../components/ui";
import { WIDGET_TYPES, widgetTitle } from "../../../components/widgets/registry";
import { t, type TextKey } from "../../../i18n";
import { ApiError } from "../../../lib/api";
import { TEMPLATES, templateWidgets, useDashboardMutations, type DashboardInfo, type TemplateId } from "../../../lib/dashboards";
import { formatRange } from "../../../lib/format";
import { GRID_WIDTHS, MAX_WIDGETS, newWidget, type GridWidth, type Widget, type WidgetType } from "../../../lib/layout";
import { ShareFields, ShareLink, draftFrom, shareErrors, sharePayload, type ShareDraft } from "./ShareFields";

const STEPS = ["dashboards.wizard.step.name", "dashboards.wizard.step.widgets", "dashboards.wizard.step.visibility", "dashboards.wizard.step.summary"] as const;

function IconBtn({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-8 items-center justify-center rounded-lg text-text-2 hover:bg-surface-2 hover:text-text disabled:opacity-40"
    >
      {children}
    </button>
  );
}

/** Lista widgetów nowego pulpitu: kolejność, szerokość, usuwanie i dodawanie (szczegóły – później w edytorze pulpitu). */
function WidgetsStep({ widgets, onChange }: { widgets: Widget[]; onChange: (w: Widget[]) => void }) {
  const [type, setType] = useState<WidgetType>("chart");
  const move = (i: number, d: -1 | 1) => {
    const next = [...widgets];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    onChange(next);
  };
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-text-2">{t("dashboards.wizard.widgets.intro")}</p>
      {widgets.length === 0 ? (
        <p className="rounded-lg bg-surface-2 px-3 py-4 text-center text-sm text-text-2">{t("dashboards.wizard.widgets.none")}</p>
      ) : (
        <ol aria-label={t("dashboards.wizard.widgets.list")} className="flex flex-col divide-y divide-border rounded-xl border border-border">
          {widgets.map((w, i) => {
            const name = widgetTitle(w);
            return (
              <li key={w.id} className="flex items-center gap-1 px-3 py-1.5">
                <span className="min-w-0 flex-1 truncate text-sm">{name}</span>
                <select
                  aria-label={t("widget.width", { name })}
                  value={w.w}
                  onChange={(e) => onChange(widgets.map((x) => (x.id === w.id ? { ...x, w: Number(e.target.value) as GridWidth } : x)))}
                  className="h-8 rounded-lg border border-border bg-surface px-1.5 text-xs"
                >
                  {GRID_WIDTHS.map((g) => (
                    <option key={g} value={g}>
                      {t(`widget.width.${g}` as TextKey)}
                    </option>
                  ))}
                </select>
                <IconBtn label={t("widget.move.earlier", { name })} onClick={() => move(i, -1)} disabled={i === 0}>
                  <IconArrowUp size={16} aria-hidden="true" />
                </IconBtn>
                <IconBtn label={t("widget.move.later", { name })} onClick={() => move(i, 1)} disabled={i === widgets.length - 1}>
                  <IconArrowDown size={16} aria-hidden="true" />
                </IconBtn>
                <IconBtn label={t("widget.remove", { name })} onClick={() => onChange(widgets.filter((x) => x.id !== w.id))}>
                  <IconTrash size={16} aria-hidden="true" />
                </IconBtn>
              </li>
            );
          })}
        </ol>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-48 flex-1">
          <Select id="wizard-add-type" label={t("dashboards.wizard.widgets.type")} value={type} onChange={(e) => setType(e.target.value as WidgetType)}>
            {WIDGET_TYPES.map((x) => (
              <option key={x.type} value={x.type}>
                {t(x.label)}
              </option>
            ))}
          </Select>
        </div>
        <Button onClick={() => onChange([...widgets, newWidget(type)])} disabled={widgets.length >= MAX_WIDGETS}>
          <IconPlus size={16} aria-hidden="true" />
          {t("dashboards.wizard.widgets.add")}
        </Button>
      </div>
    </div>
  );
}

/** Kreator nowego pulpitu: nazwa i szablon → widgety → widoczność (prywatny / publiczny) → podsumowanie z linkiem. */
export function DashboardWizard({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const { create, share } = useDashboardMutations();
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [template, setTemplate] = useState<TemplateId>("full");
  const [widgets, setWidgets] = useState<Widget[]>(() => templateWidgets("full"));
  const [draft, setDraft] = useState<ShareDraft>(() => draftFrom());
  const [nameError, setNameError] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<DashboardInfo | null>(null);
  const busy = create.isPending || share.isPending;

  const pickTemplate = (id: TemplateId) => {
    setTemplate(id);
    setWidgets(templateWidgets(id));
    // Szablon „Wyświetlacz ścienny” od razu proponuje pulpit publiczny
    if (id === "wall") setDraft((d) => ({ ...d, visibility: "public" }));
  };

  const next = () => {
    if (step === 0 && !name.trim()) return setNameError(t("dashboards.wizard.name.required"));
    if (step === 2 && Object.values(shareErrors(draft)).some(Boolean)) return;
    setStep((s) => s + 1);
  };

  const finish = async () => {
    setError(null);
    try {
      const full = await create.mutateAsync({ name: name.trim(), layout: { version: 1, widgets } });
      let info: DashboardInfo = full;
      if (draft.visibility === "public" && widgets.length > 0) info = await share.mutateAsync({ id: full.id, body: sharePayload(draft) });
      setCreated(info);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("auth.error.generic"));
    }
  };

  if (created) {
    return (
      <Dialog
        title={t("dashboards.wizard.done", { name: created.name })}
        onClose={onClose}
        footer={
          <>
            <Button onClick={onClose}>{t("common.close")}</Button>
            <Button variant="primary" onClick={() => navigate(`/dashboards/${created.id}`)}>
              {t("dashboards.open")}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm text-text-2">{t(created.public ? "dashboards.wizard.done.public" : "dashboards.wizard.done.private")}</p>
          <ShareLink info={created} />
        </div>
      </Dialog>
    );
  }

  const tpl = TEMPLATES.find((x) => x.id === template);
  return (
    <Dialog
      title={t("dashboards.wizard.title")}
      onClose={onClose}
      footer={
        <>
          {step > 0 && (
            <Button className="mr-auto" onClick={() => setStep((s) => s - 1)} disabled={busy}>
              {t("setup.back")}
            </Button>
          )}
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          {step < STEPS.length - 1 ? (
            <Button variant="primary" onClick={next}>
              {t("setup.next")}
            </Button>
          ) : (
            <Button variant="primary" onClick={finish} disabled={busy}>
              {busy ? t("common.saving") : t("dashboards.wizard.create")}
            </Button>
          )}
        </>
      }
    >
      <ol aria-label={t("setup.progress")} className="mb-4 flex flex-wrap gap-1.5 text-xs">
        {STEPS.map((s, i) => (
          <li key={s} aria-current={i === step ? "step" : undefined} className={`rounded-full px-2.5 py-1 ${i === step ? "bg-accent-soft font-medium text-accent" : "bg-surface-2 text-text-2"}`}>
            {i + 1}. {t(s)}
          </li>
        ))}
      </ol>

      {step === 0 && (
        <div className="flex flex-col gap-4">
          <Field
            id="wizard-name"
            label={t("dashboards.name")}
            value={name}
            maxLength={80}
            error={nameError}
            placeholder={t("dashboards.name.placeholder")}
            onChange={(e) => {
              setName(e.target.value);
              setNameError(undefined);
            }}
          />
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">{t("dashboards.template")}</legend>
            {TEMPLATES.map((x) => (
              <label key={x.id} className={`flex cursor-pointer gap-3 rounded-xl border p-3 ${template === x.id ? "border-accent bg-accent-soft" : "border-border hover:bg-surface-2"}`}>
                <input type="radio" name="template" checked={template === x.id} onChange={() => pickTemplate(x.id)} className="mt-1" />
                <span>
                  <span className="block text-sm font-medium">{t(x.label)}</span>
                  <span className="block text-xs text-text-2">{t(x.description)}</span>
                </span>
              </label>
            ))}
          </fieldset>
        </div>
      )}
      {step === 1 && <WidgetsStep widgets={widgets} onChange={setWidgets} />}
      {step === 2 && <ShareFields draft={draft} onChange={setDraft} />}
      {step === 3 && (
        <div className="flex flex-col gap-3">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
            <dt className="text-text-2">{t("dashboards.name")}</dt>
            <dd>{name.trim()}</dd>
            <dt className="text-text-2">{t("dashboards.template")}</dt>
            <dd>{tpl ? t(tpl.label) : "–"}</dd>
            <dt className="text-text-2">{t("dashboards.widgets")}</dt>
            <dd>{widgets.length}</dd>
            <dt className="text-text-2">{t("share.visibility")}</dt>
            <dd>
              {draft.visibility === "private"
                ? t("share.private")
                : t("dashboards.wizard.summary.public", { refresh: draft.options.refresh_s, range: formatRange(draft.options.range_min) })}
            </dd>
          </dl>
          {draft.visibility === "public" && widgets.length === 0 && <ErrorNote>{t("dashboards.wizard.publicEmpty")}</ErrorNote>}
          <p className="text-xs text-text-2">{t("dashboards.wizard.summary.hint")}</p>
          {error && <ErrorNote>{error}</ErrorNote>}
        </div>
      )}
    </Dialog>
  );
}
