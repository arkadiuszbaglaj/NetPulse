/**
 * Okno „Dodaj widget” (od 0.44.0): szablony według rodzaju albo według urządzenia, wyszukiwarka, krok z pytaniami
 * i podglądem na żywo. Pełny edytor zostaje pod „Własny” i pod „Więcej opcji”.
 */
import { IconChevronLeft, IconSearch, IconWorld } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { t } from "../../i18n";
import { get, type Device } from "../../lib/api";
import { useChecks } from "../../lib/checks";
import type { InterfaceItem, WifiItem } from "../../lib/details";
import { defaultHeight, rowsToPx, type Widget, type WidgetType } from "../../lib/layout";
import { isOn, useModules, type ModuleId } from "../../lib/modules";
import { useDevices } from "../../lib/queries";
import {
  TEMPLATE_GROUPS,
  WIDGET_TEMPLATES,
  deviceSection,
  needsSetup,
  normalize,
  templateDesc,
  templateLabel,
  templatesForDevice,
  type TemplateGroup,
  type TemplateOption,
  type WidgetTemplate,
} from "../../lib/widgetTemplates";
import { Dialog } from "../Dialog";
import { Button, Field, Select } from "../ui";
import { Checkbox } from "./ChartEditor";
import { WIDGET_TYPES, WidgetView } from "./registry";
import { WidgetThumb } from "./WidgetThumb";

type Group = TemplateGroup | "custom";

export interface AddWidgetDialogProps {
  onClose: () => void;
  /** Gotowe widgety z szablonów (jeden albo kilka – cała sekcja) */
  onAdd: (widgets: Widget[]) => void;
  /** „Własny”: pusty widget danego typu do pełnego edytora */
  onCustom: (type: WidgetType) => void;
  /** „Więcej opcji”: widget z szablonu otwarty w pełnym edytorze */
  onAdvanced: (widget: Widget) => void;
}

function useModuleFilter() {
  const { data } = useModules();
  return (m?: ModuleId) => isOn(data, m);
}

const asksText = (tpl: WidgetTemplate) => (tpl.asks.length ? t("addw.asks", { what: tpl.asks.map((a) => t(`addw.ask.${a}`)).join(", ") }) : null);

function TemplateCard({ tpl, onPick }: { tpl: WidgetTemplate; onPick: () => void }) {
  return (
    <button
      type="button"
      onClick={onPick}
      className={`flex flex-col gap-2 rounded-xl border bg-surface p-3 text-left transition-colors hover:bg-surface-2 ${tpl.recommended ? "border-[color:var(--state-up)] ring-2 ring-[color:var(--state-up)]/30" : "border-border"}`}
    >
      <WidgetThumb kind={tpl.thumb} />
      <span className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">{t(templateLabel(tpl))}</span>
        {tpl.recommended && <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-semibold text-accent">{t("addw.recommended")}</span>}
      </span>
      <span className="text-xs leading-relaxed text-text-2">{t(templateDesc(tpl))}</span>
      {asksText(tpl) && <span className="text-[11px] text-muted">{asksText(tpl)}</span>}
    </button>
  );
}

function CustomCard({ type, onPick }: { type: (typeof WIDGET_TYPES)[number]; onPick: () => void }) {
  const Icon = type.icon;
  return (
    <button type="button" onClick={onPick} className="flex items-start gap-3 rounded-xl border border-border p-3 text-left hover:bg-surface-2">
      <Icon size={22} aria-hidden="true" className="mt-0.5 shrink-0 text-accent" />
      <span>
        <span className="block text-sm font-medium">{t(type.label)}</span>
        <span className="block text-xs text-text-2">{t(type.description)}</span>
      </span>
    </button>
  );
}

// --- krok pytań z podglądem ------------------------------------------------------------------

function SetupStep({
  tpl,
  initialDeviceId,
  onBack,
  onAdd,
  onAdvanced,
}: {
  tpl: WidgetTemplate;
  initialDeviceId?: number | null;
  onBack: () => void;
  onAdd: (w: Widget) => void;
  onAdvanced: (w: Widget) => void;
}) {
  const needDevice = tpl.asks.includes("device");
  const needPort = tpl.asks.includes("port");
  const needCheck = tpl.asks.includes("check");
  const devices = (useDevices().data ?? []).filter((d) => d.enabled && (!tpl.fits || tpl.fits(d)));
  const checks = useChecks().data ?? [];
  const [deviceId, setDeviceId] = useState<number | null>(initialDeviceId ?? null);
  const device = devices.find((d) => d.id === deviceId) ?? (needDevice ? (devices[0] ?? null) : null);
  const wantsPorts = needPort || tpl.id === "ports_timeline";
  const ports = useQuery({
    queryKey: ["device-interfaces", device?.id ?? 0],
    queryFn: () => get<InterfaceItem[]>(`/api/devices/${device!.id}/interfaces`),
    enabled: wantsPorts && !!device,
  }).data;
  const networks = useQuery({
    queryKey: ["device-wifi", device?.id ?? 0],
    queryFn: () => get<WifiItem[]>(`/api/devices/${device!.id}/wifi`),
    enabled: tpl.id === "wifi_networks" && !!device,
  }).data;
  // Porty z linkiem na górze, ukryte (wirtualne, techniczne) pominięte
  const portList = useMemo(() => (ports ?? []).filter((p) => !p.hidden).sort((a, b) => Number(b.oper_status === "up") - Number(a.oper_status === "up")), [ports]);
  const [portId, setPortId] = useState<number | null>(null);
  const port = portList.find((p) => p.id === portId) ?? portList[0] ?? null;
  const [checkId, setCheckId] = useState<number | null>(null);
  const check = checks.find((c) => c.id === checkId) ?? checks[0] ?? null;
  const [options, setOptions] = useState<Partial<Record<TemplateOption, boolean>>>({ limitLine: true, compare: tpl.id === "wan_traffic" });
  const [w, setW] = useState(tpl.sizes[0]);
  const [title, setTitle] = useState("");

  const ready = (!needDevice || !!device) && (!needPort || !!port) && (!needCheck || !!check);
  const widget = useMemo(
    () => (ready ? tpl.build({ device, port, ports: portList, networks, check: check ? { id: check.id, name: check.name } : null, options, w, title }) : null),
    [ready, tpl, device?.id, port?.id, portList, networks, check?.id, JSON.stringify(options), w, title],
  );
  useEffect(() => setPortId(null), [device?.id]);
  const portLabel = (p: InterfaceItem) => [p.label || p.name, p.alias, p.speed_mbps ? (p.speed_mbps >= 1000 ? `${p.speed_mbps / 1000} Gb/s` : `${p.speed_mbps} Mb/s`) : null].filter(Boolean).join(" · ");

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <button type="button" onClick={onBack} aria-label={t("addw.back")} className="flex size-10 items-center justify-center rounded-lg text-text-2 hover:bg-surface-2 hover:text-text">
          <IconChevronLeft size={18} aria-hidden="true" />
        </button>
        <div>
          <p className="text-xs text-muted">{t("addw.setupKicker", { group: t(`addw.group.${tpl.group}`) })}</p>
          <h3 className="text-[17px] font-semibold">{t(templateLabel(tpl))}</h3>
        </div>
      </div>

      <div className="flex flex-col gap-5 lg:flex-row">
        <div className="flex flex-col gap-4 lg:w-80 lg:shrink-0">
          {needDevice &&
            (devices.length ? (
              <Select id="addw-device" label={t("addw.step.device")} value={device?.id ?? ""} onChange={(e) => setDeviceId(Number(e.target.value))}>
                {devices.map((d: Device) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </Select>
            ) : (
              <p className="text-sm text-muted">{t("addw.device.none")}</p>
            ))}
          {needPort &&
            device &&
            (portList.length ? (
              <div className="flex flex-col gap-1.5">
                <Select id="addw-port" label={t("addw.step.port")} value={port?.id ?? ""} onChange={(e) => setPortId(Number(e.target.value))}>
                  {portList.map((p) => (
                    <option key={p.id} value={p.id}>
                      {portLabel(p)}
                    </option>
                  ))}
                </Select>
                <p className="text-xs text-muted">{t("addw.port.hint")}</p>
              </div>
            ) : (
              ports && <p className="text-sm text-muted">{t("addw.port.none")}</p>
            ))}
          {needCheck &&
            (checks.length ? (
              <Select id="addw-check" label={t("addw.step.check")} value={check?.id ?? ""} onChange={(e) => setCheckId(Number(e.target.value))}>
                {checks.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            ) : (
              <p className="text-sm text-muted">{t("addw.check.none")}</p>
            ))}
          {(tpl.options?.length ?? 0) > 0 && (
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium">{t("addw.options")}</legend>
              {tpl.options!.map((o) => (
                <Checkbox key={o} id={`addw-opt-${o}`} label={t(`addw.opt.${o}`)} checked={!!options[o]} onChange={(v) => setOptions((x) => ({ ...x, [o]: v }))} />
              ))}
            </fieldset>
          )}
          {tpl.sizes.length > 1 && (
            <Select id="addw-size" label={t("addw.size")} value={w} onChange={(e) => setW(Number(e.target.value))}>
              {tpl.sizes.map((s) => (
                <option key={s} value={s}>
                  {t(`addw.size.${s}` as Parameters<typeof t>[0])}
                </option>
              ))}
            </Select>
          )}
          <Field id="addw-title" label={t("addw.titleField")} hint={t("addw.titleHint")} value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} />
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-2 rounded-xl bg-surface-2 p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted">{t("addw.preview")}</p>
          {widget && (
            // Wysokość jak na pulpicie (minimum) – wykres rośnie o legendę, liczby i wskaźniki wypełniają pole
            <div className="flex flex-col *:flex-1" style={{ minHeight: rowsToPx(Math.min(defaultHeight(widget), 12)) }}>
              <WidgetView widget={widget} />
            </div>
          )}
          <p className="text-xs text-muted">{t("addw.previewHint")}</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
        <button type="button" disabled={!widget} onClick={() => widget && onAdvanced(widget)} className="text-[13px] font-medium text-text-2 hover:text-text disabled:opacity-50">
          {t("addw.advanced")}
        </button>
        <div className="flex gap-2">
          <Button onClick={onBack}>{t("common.back")}</Button>
          <Button variant="primary" disabled={!widget} onClick={() => widget && onAdd(widget)}>
            {t("addw.add")}
          </Button>
        </div>
      </div>
    </div>
  );
}

// --- według urządzenia --------------------------------------------------------------------------

function DeviceTab({ onAdd, onSetup }: { onAdd: (widgets: Widget[]) => void; onSetup: (tpl: WidgetTemplate, deviceId: number | null) => void }) {
  const modulesOn = useModuleFilter();
  const devices = (useDevices().data ?? []).filter((d) => d.enabled);
  const [selected, setSelected] = useState<number | "network" | null>(null);
  const current = selected === "network" ? null : (devices.find((d) => d.id === selected) ?? (selected === null ? (devices[0] ?? null) : null));
  const network = selected === "network";
  const [checked, setChecked] = useState<Set<string>>(new Set());
  useEffect(() => setChecked(new Set()), [selected]);
  const networks = useQuery({
    queryKey: ["device-wifi", current?.id ?? 0],
    queryFn: () => get<WifiItem[]>(`/api/devices/${current!.id}/wifi`),
    enabled: current?.kind === "ap",
  }).data;
  const list = network ? WIDGET_TEMPLATES.filter((tpl) => tpl.asks.length === 0 && modulesOn(tpl.module)) : current ? templatesForDevice(current, modulesOn) : [];
  const section = current ? deviceSection(current, { networks }, modulesOn) : [];
  const build = (tpl: WidgetTemplate) => tpl.build({ device: current, networks });
  const toggle = (id: string, on: boolean) => setChecked((s) => (on ? new Set([...s, id]) : new Set([...s].filter((x) => x !== id))));
  const dot: Record<string, string> = { up: "bg-success", down: "bg-danger" };

  return (
    <div className="flex flex-col gap-4 md:flex-row">
      <nav aria-label={t("addw.devices")} className="flex shrink-0 flex-col gap-1 md:w-60">
        <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">{t("addw.network")}</p>
        <button
          type="button"
          aria-pressed={network}
          onClick={() => setSelected("network")}
          className={`flex min-h-11 items-center gap-2.5 rounded-lg px-2.5 text-left text-sm ${network ? "bg-surface-2 font-semibold" : "font-medium hover:bg-surface-2"}`}
        >
          <IconWorld size={18} aria-hidden="true" className="text-text-2" />
          {t("addw.group.internet")}
        </button>
        <p className="px-2 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-muted">{t("addw.devices")}</p>
        {devices.map((d) => {
          const active = current?.id === d.id && !network;
          return (
            <button
              key={d.id}
              type="button"
              aria-pressed={active}
              onClick={() => setSelected(d.id)}
              className={`flex min-h-12 items-center gap-2.5 rounded-lg px-2.5 text-left ${active ? "bg-surface-2" : "hover:bg-surface-2"}`}
            >
              <span className={`size-2 shrink-0 rounded-full ${dot[d.status] ?? "bg-border-strong"}`} aria-hidden="true" />
              <span className="min-w-0">
                <span className={`block truncate text-sm ${active ? "font-semibold" : "font-medium"}`}>{d.name}</span>
                <span className="block truncate text-xs text-muted">{[d.model, d.host].filter(Boolean).join(" · ")}</span>
              </span>
            </button>
          );
        })}
      </nav>

      <div className="flex min-w-0 flex-1 flex-col gap-3">
        {current && section.length > 1 && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[color:var(--state-up)] bg-surface-2 p-4">
            <div>
              <p className="text-[15px] font-semibold">{t("addw.section", { name: current.name })}</p>
              <p className="text-[13px] text-text-2">{t("addw.section.desc", { n: section.length - 1 })}</p>
            </div>
            <Button variant="primary" onClick={() => onAdd(section)}>
              {t("addw.section.add")}
            </Button>
          </div>
        )}
        {!current && !network && <p className="text-sm text-muted">{t("addw.selectDevice")}</p>}
        {current && section.length > 1 && <p className="text-[13px] font-semibold text-text-2">{t("addw.orPick")}</p>}
        <ul className="flex flex-col gap-2">
          {list.map((tpl) => {
            const port = tpl.asks.includes("port") || tpl.asks.includes("check");
            const on = checked.has(tpl.id);
            return (
              <li key={tpl.id} className={`flex items-center gap-3 rounded-xl border p-2 pr-3 ${on ? "border-[color:var(--state-up)]" : "border-border"}`}>
                {port ? (
                  <span className="w-5 shrink-0" />
                ) : (
                  <input
                    type="checkbox"
                    id={`addw-pick-${tpl.id}`}
                    checked={on}
                    onChange={(e) => toggle(tpl.id, e.target.checked)}
                    className="size-[18px] shrink-0 accent-[var(--accent)]"
                  />
                )}
                <span className="w-32 shrink-0">
                  <WidgetThumb kind={tpl.thumb} height={60} />
                </span>
                <label htmlFor={port ? undefined : `addw-pick-${tpl.id}`} className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold">{t(templateLabel(tpl))}</span>
                  <span className="block text-xs text-text-2">{t(templateDesc(tpl))}</span>
                </label>
                {port && (
                  <Button onClick={() => onSetup(tpl, current?.id ?? null)}>{t("addw.pickPort")}</Button>
                )}
              </li>
            );
          })}
        </ul>
        {(current || network) && (
          <div className="flex justify-end border-t border-border pt-3">
            <Button variant="primary" disabled={checked.size === 0} onClick={() => onAdd(list.filter((tpl) => checked.has(tpl.id)).map(build))}>
              {t("addw.addChecked", { n: checked.size })}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

// --- całe okno -----------------------------------------------------------------------------------

export function AddWidgetDialog({ onClose, onAdd, onCustom, onAdvanced }: AddWidgetDialogProps) {
  const modulesOn = useModuleFilter();
  const [tab, setTab] = useState<"kind" | "device">("kind");
  const [group, setGroup] = useState<Group>("overview");
  const [query, setQuery] = useState("");
  const [setup, setSetup] = useState<{ tpl: WidgetTemplate; deviceId: number | null } | null>(null);

  const templates = WIDGET_TEMPLATES.filter((tpl) => modulesOn(tpl.module));
  const q = normalize(query.trim());
  const found = q ? templates.filter((tpl) => normalize(`${t(templateLabel(tpl))} ${t(templateDesc(tpl))} ${t(`addw.group.${tpl.group}`)}`).includes(q)) : [];
  const foundCustom = q ? WIDGET_TYPES.filter((x) => normalize(`${t(x.label)} ${t(x.description)}`).includes(q)) : [];
  const pick = (tpl: WidgetTemplate, deviceId: number | null = null) => (needsSetup(tpl) ? setSetup({ tpl, deviceId }) : onAdd([tpl.build({})]));
  const counts = (g: Group) => (g === "custom" ? WIDGET_TYPES.length : templates.filter((tpl) => tpl.group === g).length);

  return (
    <Dialog title={t("addw.title")} size="xl" onClose={onClose}>
      {setup ? (
        <SetupStep
          tpl={setup.tpl}
          initialDeviceId={setup.deviceId}
          onBack={() => setSetup(null)}
          onAdd={(w) => onAdd([w])}
          onAdvanced={onAdvanced}
        />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <label className="flex h-10 flex-1 items-center gap-2 rounded-lg border border-border-strong px-3 text-muted focus-within:outline-2 focus-within:outline-accent">
              <IconSearch size={16} aria-hidden="true" />
              <span className="sr-only">{t("addw.searchLabel")}</span>
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("addw.search")}
                className="min-w-0 flex-1 bg-transparent text-sm text-text outline-none placeholder:text-muted"
              />
            </label>
            <div role="tablist" aria-label={t("addw.tabs")} className="flex gap-0.5 self-start rounded-lg bg-surface-2 p-0.5">
              {(["kind", "device"] as const).map((x) => (
                <button
                  key={x}
                  type="button"
                  role="tab"
                  aria-selected={tab === x}
                  onClick={() => setTab(x)}
                  className={`h-9 rounded-md px-3 text-[13px] ${tab === x ? "bg-surface font-semibold shadow-sm" : "font-medium text-text-2 hover:text-text"}`}
                >
                  {t(`addw.tab.${x}`)}
                </button>
              ))}
            </div>
          </div>

          {q ? (
            <section aria-label={t("addw.results", { q: query.trim() })} className="flex flex-col gap-3">
              <p className="text-sm font-semibold">{t("addw.results", { q: query.trim() })}</p>
              {found.length + foundCustom.length === 0 && <p className="text-sm text-muted">{t("addw.noResults")}</p>}
              <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
                {found.map((tpl) => (
                  <TemplateCard key={tpl.id} tpl={tpl} onPick={() => pick(tpl)} />
                ))}
              </div>
              {foundCustom.length > 0 && (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-2">
                  {foundCustom.map((x) => (
                    <CustomCard key={x.type} type={x} onPick={() => onCustom(x.type)} />
                  ))}
                </div>
              )}
            </section>
          ) : tab === "device" ? (
            <DeviceTab onAdd={onAdd} onSetup={(tpl, deviceId) => setSetup({ tpl, deviceId })} />
          ) : (
            <div className="flex flex-col gap-4 md:flex-row">
              <nav aria-label={t("addw.groups")} className="flex shrink-0 flex-row flex-wrap gap-1 md:w-52 md:flex-col">
                {[...TEMPLATE_GROUPS, "custom" as const].map((g) => (
                  <button
                    key={g}
                    type="button"
                    aria-pressed={group === g}
                    onClick={() => setGroup(g)}
                    className={`flex min-h-10 items-center justify-between gap-3 rounded-lg px-3 text-left text-sm ${group === g ? "bg-surface-2 font-semibold" : "font-medium hover:bg-surface-2"}`}
                  >
                    <span>{t(`addw.group.${g}`)}</span>
                    <span className="text-xs text-muted">{counts(g)}</span>
                  </button>
                ))}
                <p className="mt-3 hidden rounded-lg border border-dashed border-border-strong p-3 text-xs leading-relaxed text-text-2 md:block">{t("addw.hint")}</p>
              </nav>
              <section aria-label={t(`addw.group.${group}`)} className="flex min-w-0 flex-1 flex-col gap-3">
                <div>
                  <h3 className="text-[15px] font-semibold">{t(`addw.group.${group}`)}</h3>
                  <p className="text-[13px] text-muted">{t(`addw.group.${group}.desc`)}</p>
                </div>
                {group === "custom" ? (
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-2">
                    {WIDGET_TYPES.map((x) => (
                      <CustomCard key={x.type} type={x} onPick={() => onCustom(x.type)} />
                    ))}
                  </div>
                ) : (
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
                    {templates
                      .filter((tpl) => tpl.group === group)
                      .map((tpl) => (
                        <TemplateCard key={tpl.id} tpl={tpl} onPick={() => pick(tpl)} />
                      ))}
                  </div>
                )}
              </section>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3 text-[13px] text-text-2">
            <span>{t("addw.footer")}</span>
            <button type="button" onClick={() => {
                setQuery("");
                setTab("kind");
                setGroup("custom");
              }} className="font-medium text-text hover:underline">
              {t("addw.custom")}
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
