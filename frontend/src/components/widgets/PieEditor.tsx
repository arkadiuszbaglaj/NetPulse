/** Edytor wykresu kołowego: najpierw urządzenie (albo cała sieć), potem co na nim monitorować. */
import { useState } from "react";
import { t } from "../../i18n";
import type { PieConfig, PieMetric } from "../../lib/layout";
import { isOn, useModules } from "../../lib/modules";
import { useCollection } from "../../lib/panels";
import { PIE_METRICS, pieMetricsFor } from "../../lib/pie";
import { useDevices } from "../../lib/queries";
import { Field, Select } from "../ui";
import { EditorDialog } from "./PanelEditors";
import { PieWidget } from "./PieWidget";

/** Metryki z modułów (agenci, Proxmox) znikają, gdy moduł jest wyłączony. */
const METRIC_MODULE: Partial<Record<PieMetric, "agents" | "proxmox">> = {
  containers_mem: "agents",
  containers_cpu: "agents",
  services_state: "agents",
  guests_mem: "proxmox",
  guests_state: "proxmox",
};

export function PieForm({ initial, isNew, onSave, onClose }: { initial: PieConfig; isNew: boolean; onSave: (c: PieConfig) => void; onClose: () => void }) {
  const [cfg, setCfg] = useState(initial);
  const devices = useDevices();
  const mods = useModules().data;
  const device = devices.data?.find((d) => d.id === cfg.device_id) ?? null;
  const metrics = pieMetricsFor(device).filter((m) => isOn(mods, METRIC_MODULE[m] ?? null));
  const disks = useCollection({ kind: "disks", device_id: cfg.device_id }, cfg.metric === "disk" && !!cfg.device_id);
  const set = (patch: Partial<PieConfig>) => setCfg((c) => ({ ...c, ...patch }));
  const mode = PIE_METRICS[cfg.metric].mode;

  const pickDevice = (value: string) => {
    const id = value ? Number(value) : null;
    const next = pieMetricsFor(devices.data?.find((d) => d.id === id) ?? null);
    set({ device_id: id, metric: next.includes(cfg.metric) ? cfg.metric : next[0], item: null });
  };
  const submit = () => onSave({ ...cfg, title: cfg.title?.trim() || null, item: cfg.metric === "disk" ? cfg.item || null : null });

  return (
    <EditorDialog title={t(isNew ? "pe.pie.new" : "pe.pie.edit")} onSave={submit} onClose={onClose} preview={<PieWidget config={cfg} />}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Select id="pe-pie-device" label={t("pe.pie.device")} value={cfg.device_id ?? ""} onChange={(e) => pickDevice(e.target.value)}>
          <option value="">{t("pe.pie.network")}</option>
          {(devices.data ?? []).map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </Select>
        <Select id="pe-pie-metric" label={t("pe.pie.metric")} value={cfg.metric} onChange={(e) => set({ metric: e.target.value as PieMetric, item: null })}>
          {metrics.map((m) => (
            <option key={m} value={m}>
              {t(PIE_METRICS[m].label)}
            </option>
          ))}
        </Select>
        {cfg.metric === "disk" && (
          <Select id="pe-pie-disk" label={t("pe.pie.disk")} value={cfg.item ?? ""} onChange={(e) => set({ item: e.target.value || null })}>
            <option value="">{t("pe.pie.disk.first")}</option>
            {(disks.data ?? []).map((r) => (
              <option key={r.key} value={r.key}>
                {r.label}
              </option>
            ))}
          </Select>
        )}
        {mode === "share" && (
          <Field
            id="pe-pie-limit"
            label={t("pe.pie.limit")}
            hint={t("pe.pie.limit.hint")}
            type="number"
            min={2}
            max={12}
            value={cfg.limit}
            onChange={(e) => set({ limit: Math.min(12, Math.max(2, Number(e.target.value) || 2)) })}
          />
        )}
      </div>
      <p className="-mt-2 text-xs text-text-2">{t(`pe.pie.mode.${mode}`)}</p>
      <Field id="pe-title" label={t("ce.field.title")} hint={t("ce.field.title.hint")} value={cfg.title ?? ""} maxLength={80} onChange={(e) => set({ title: e.target.value })} />
    </EditorDialog>
  );
}
