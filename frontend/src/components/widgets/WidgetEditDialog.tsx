/** Okna edycji widgetów: wykres (źródło, metryki, wygląd), podsumowanie (kafelki), karty urządzeń (filtr). */
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { t, type TextKey } from "../../i18n";
import { get, type Device } from "../../lib/api";
import {
  DEVICE_KINDS,
  METRICS,
  SOURCE_KINDS,
  SOURCE_METRICS,
  SUMMARY_TILES,
  defaultSeries,
  toggleMetric,
  unitClassOf,
  yMaxFromRaw,
  yMaxToRaw,
  type ChartConfig,
  type ChartHeight,
  type ChartKind,
  type ChartUnit,
  type ColorIndex,
  type DeviceKind,
  type Source,
  type SourceKind,
  type SummaryTile,
  type Widget,
} from "../../lib/layout";
import { useDevices } from "../../lib/queries";
import { formatRange } from "../../lib/format";
import { RANGE_OPTIONS, REFRESH_OPTIONS, type RangeMinutes, type RefreshSeconds } from "../../lib/refresh";
import { Dialog } from "../Dialog";
import { refreshLabel } from "../RefreshControl";
import { Button, Field, Select } from "../ui";
import { ChartWidget } from "./ChartWidget";
import { KIND_LABEL } from "./DevicesWidget";

interface InterfaceItem {
  id: number;
  label: string;
  alias: string | null;
}
interface WifiItem {
  id: number;
  ssid: string;
  radio: string | null;
}

const SOURCE_LABEL: Record<SourceKind, TextKey> = {
  wan: "ce.source.wan",
  interface: "ce.source.interface",
  device: "ce.source.device",
  wifi_total: "ce.source.wifi_total",
  wifi_network: "ce.source.wifi_network",
};
const TILE_LABEL: Record<SummaryTile, TextKey> = {
  devices: "widget.tile.devices",
  wan_down: "widget.tile.wan_down",
  wan_up: "widget.tile.wan_up",
  wifi_clients: "widget.tile.wifi_clients",
};
const KIND_OPTIONS: ChartKind[] = ["area", "line", "bar"];
const HEIGHTS: ChartHeight[] = ["sm", "md", "lg"];
const COLORS: ColorIndex[] = [1, 2, 3, 4];

function Checkbox({ id, label, checked, onChange }: { id: string; label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label htmlFor={id} className="flex items-center gap-2 text-sm">
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="size-4 accent-accent" />
      {label}
    </label>
  );
}

// --- wykres ------------------------------------------------------------------------------------

/** Id urządzenia wybranego w formularzu: dla portu i sieci WiFi zapisane razem ze źródłem. */
const deviceIdOf = (s: Source): number | null =>
  s.kind === "device" ? s.id : s.kind === "interface" || s.kind === "wifi_network" ? (s.device_id ?? null) : null;

function ChartForm({ initial, onSave, onClose, isNew }: { initial: ChartConfig; onSave: (c: ChartConfig) => void; onClose: () => void; isNew: boolean }) {
  const [cfg, setCfg] = useState<ChartConfig>(initial);
  const [yMax, setYMax] = useState(
    initial.y_max != null ? String(yMaxFromRaw(initial.y_max, initial.series[0]?.key ?? "", initial.unit)) : "",
  );
  const [errors, setErrors] = useState<{ source?: string; metrics?: string; ymax?: string }>({});
  const devices = useDevices();
  const [deviceId, setDeviceId] = useState<number | null>(deviceIdOf(initial.source));

  const needsDevice = cfg.source.kind === "interface" || cfg.source.kind === "wifi_network";
  const interfaces = useQuery({
    queryKey: ["device-interfaces", deviceId],
    queryFn: () => get<InterfaceItem[]>(`/api/devices/${deviceId}/interfaces`),
    enabled: cfg.source.kind === "interface" && deviceId != null,
  });
  const wifi = useQuery({
    queryKey: ["device-wifi", deviceId],
    queryFn: () => get<WifiItem[]>(`/api/devices/${deviceId}/wifi`),
    enabled: cfg.source.kind === "wifi_network" && deviceId != null,
  });

  const firstKey = cfg.series[0]?.key ?? "";
  const cls = unitClassOf(firstKey);
  const set = (patch: Partial<ChartConfig>) => setCfg((c) => ({ ...c, ...patch }));

  const changeKind = (kind: SourceKind) => {
    const source: Source =
      kind === "wan" || kind === "wifi_total"
        ? { kind }
        : kind === "device"
          ? { kind, id: deviceId ?? 0 }
          : { kind, id: 0, device_id: deviceId };
    set({ source, series: defaultSeries(kind) });
  };
  const changeDevice = (id: number | null) => {
    setDeviceId(id);
    if (cfg.source.kind === "device") set({ source: { kind: "device", id: id ?? 0 } });
    else if (needsDevice) set({ source: { ...cfg.source, id: 0, device_id: id } as Source });
  };

  const submit = () => {
    const next: typeof errors = {};
    const s = cfg.source;
    if ((s.kind === "interface" || s.kind === "device" || s.kind === "wifi_network") && !s.id) next.source = t("ce.err.source");
    if (cfg.series.length === 0) next.metrics = t("ce.err.metrics");
    let y: number | null = null;
    if (yMax.trim() !== "") {
      const n = Number(yMax.replace(",", "."));
      if (!Number.isFinite(n) || n <= 0) next.ymax = t("ce.err.ymax");
      else y = yMaxToRaw(n, firstKey, cfg.unit);
    }
    setErrors(next);
    if (Object.keys(next).length === 0) onSave({ ...cfg, title: cfg.title?.trim() || null, y_max: y });
  };

  const unitHint =
    cls === "rate"
      ? t(cfg.unit === "bytes" ? "ce.unit.hint.rate.bytes" : "ce.unit.hint.rate.bits")
      : cls === "percent"
        ? t("ce.unit.hint.percent")
        : cls === "ms"
          ? t("ce.unit.hint.ms")
          : t("ce.unit.hint.other");

  const previewOk = useMemo(() => {
    const s = cfg.source;
    const sourceOk = !(s.kind === "interface" || s.kind === "device" || s.kind === "wifi_network") || !!s.id;
    return sourceOk && cfg.series.length > 0;
  }, [cfg]);

  return (
    <Dialog
      title={t(isNew ? "ce.title.new" : "ce.title.edit")}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={submit}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field id="ce-title" label={t("ce.field.title")} hint={t("ce.field.title.hint")} value={cfg.title ?? ""} maxLength={80} onChange={(e) => set({ title: e.target.value })} />

        <Select id="ce-source" label={t("ce.source")} value={cfg.source.kind} error={errors.source} onChange={(e) => changeKind(e.target.value as SourceKind)}>
          {SOURCE_KINDS.map((k) => (
            <option key={k} value={k}>
              {t(SOURCE_LABEL[k])}
            </option>
          ))}
        </Select>

        {(needsDevice || cfg.source.kind === "device") && (
          <Select
            id="ce-device"
            label={t("ce.device")}
            value={deviceId ?? ""}
            onChange={(e) => changeDevice(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">{t("ce.choose")}</option>
            {(devices.data ?? []).map((d: Device) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
        )}
        {needsDevice && devices.data?.length === 0 && <p className="text-xs text-text-2">{t("ce.noDevices")}</p>}

        {cfg.source.kind === "interface" && deviceId != null && (
          <Select
            id="ce-interface"
            label={t("ce.interface")}
            value={cfg.source.id || ""}
            onChange={(e) => set({ source: { kind: "interface", id: Number(e.target.value), device_id: deviceId } })}
          >
            <option value="">{t("ce.choose")}</option>
            {(interfaces.data ?? []).map((i) => (
              <option key={i.id} value={i.id}>
                {i.alias ? `${i.label} (${i.alias})` : i.label}
              </option>
            ))}
          </Select>
        )}
        {cfg.source.kind === "interface" && interfaces.data?.length === 0 && <p className="text-xs text-text-2">{t("ce.noInterfaces")}</p>}

        {cfg.source.kind === "wifi_network" && deviceId != null && (
          <Select
            id="ce-wifi"
            label={t("ce.wifi")}
            value={cfg.source.id || ""}
            onChange={(e) => set({ source: { kind: "wifi_network", id: Number(e.target.value), device_id: deviceId } })}
          >
            <option value="">{t("ce.choose")}</option>
            {(wifi.data ?? []).map((w) => (
              <option key={w.id} value={w.id}>
                {w.radio ? `${w.ssid} (${w.radio})` : w.ssid}
              </option>
            ))}
          </Select>
        )}
        {cfg.source.kind === "wifi_network" && wifi.data?.length === 0 && <p className="text-xs text-text-2">{t("ce.noWifi")}</p>}

        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">{t("ce.metrics")}</legend>
          <p className="text-xs text-muted">{t("ce.metrics.hint")}</p>
          {SOURCE_METRICS[cfg.source.kind].map((key) => {
            const selected = cfg.series.find((s) => s.key === key);
            const name = t(METRICS[key].label);
            return (
              <div key={key} className="flex flex-wrap items-center gap-3">
                <Checkbox id={`ce-m-${key}`} label={name} checked={!!selected} onChange={(on) => set({ series: toggleMetric(cfg.series, key, on) })} />
                {selected && (
                  <div role="group" aria-label={t("ce.color", { name })} className="flex gap-1.5">
                    {COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        aria-label={t("ce.colorN", { n: c })}
                        aria-pressed={selected.color === c}
                        onClick={() => set({ series: cfg.series.map((s) => (s.key === key ? { ...s, color: c } : s)) })}
                        style={{ backgroundColor: `var(--chart-${c})` }}
                        className={`size-5 rounded-full border-2 ${selected.color === c ? "border-text" : "border-transparent"}`}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {errors.metrics && <p className="text-xs text-danger">{errors.metrics}</p>}
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <Select id="ce-kind" label={t("ce.kind")} value={cfg.chart} onChange={(e) => set({ chart: e.target.value as ChartKind })}>
            {KIND_OPTIONS.map((k) => (
              <option key={k} value={k}>
                {t(`ce.kind.${k}` as TextKey)}
              </option>
            ))}
          </Select>
          <Select id="ce-height" label={t("ce.height")} value={cfg.height} onChange={(e) => set({ height: e.target.value as ChartHeight })}>
            {HEIGHTS.map((h) => (
              <option key={h} value={h}>
                {t(`ce.height.${h}` as TextKey)}
              </option>
            ))}
          </Select>
          {cls === "rate" && (
            <Select id="ce-unit" label={t("ce.unit")} value={cfg.unit} onChange={(e) => set({ unit: e.target.value as ChartUnit })}>
              <option value="bits">{t("ce.unit.bits")}</option>
              <option value="bytes">{t("ce.unit.bytes")}</option>
            </Select>
          )}
          <Field
            id="ce-ymax"
            label={t("ce.ymax")}
            hint={t("ce.ymax.hint", { unit: unitHint })}
            inputMode="decimal"
            value={yMax}
            error={errors.ymax}
            onChange={(e) => setYMax(e.target.value)}
          />
          <Select
            id="ce-range"
            label={t("ce.range")}
            value={cfg.range_min ?? ""}
            onChange={(e) => set({ range_min: e.target.value ? (Number(e.target.value) as RangeMinutes) : null })}
          >
            <option value="">{t("ce.range.global")}</option>
            {RANGE_OPTIONS.map((m) => (
              <option key={m} value={m}>
                {formatRange(m)}
              </option>
            ))}
          </Select>
          <Select
            id="ce-refresh"
            label={t("ce.refresh")}
            value={cfg.refresh_s ?? ""}
            onChange={(e) => set({ refresh_s: e.target.value === "" ? null : (Number(e.target.value) as RefreshSeconds) })}
          >
            <option value="">{t("ce.refresh.global")}</option>
            {REFRESH_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {refreshLabel(s)}
              </option>
            ))}
          </Select>
        </div>
        <Checkbox id="ce-smooth" label={t("ce.smooth")} checked={cfg.smooth} onChange={(v) => set({ smooth: v })} />

        <section aria-label={t("ce.preview")}>
          <h3 className="mb-2 text-sm font-medium">{t("ce.preview")}</h3>
          {previewOk ? <ChartWidget config={{ ...cfg, y_max: null }} /> : <p className="text-xs text-text-2">{t("ce.preview.invalid")}</p>}
        </section>
      </div>
    </Dialog>
  );
}

// --- podsumowanie i karty urządzeń -------------------------------------------------------------

function SummaryForm({ initial, onSave, onClose }: { initial: SummaryTile[]; onSave: (tiles: SummaryTile[]) => void; onClose: () => void }) {
  const [tiles, setTiles] = useState<SummaryTile[]>(initial);
  const [error, setError] = useState(false);
  const toggle = (tile: SummaryTile, on: boolean) =>
    setTiles(SUMMARY_TILES.filter((x) => (x === tile ? on : tiles.includes(x)))); // zachowuje stałą kolejność
  return (
    <Dialog
      title={t("widget.type.summary")}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            onClick={() => (tiles.length === 0 ? setError(true) : onSave(tiles))}
          >
            {t("common.save")}
          </Button>
        </>
      }
    >
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">{t("widget.summary.tiles")}</legend>
        {SUMMARY_TILES.map((tile) => (
          <Checkbox key={tile} id={`st-${tile}`} label={t(TILE_LABEL[tile])} checked={tiles.includes(tile)} onChange={(on) => toggle(tile, on)} />
        ))}
        {error && tiles.length === 0 && <p className="text-xs text-danger">{t("widget.summary.err")}</p>}
      </fieldset>
    </Dialog>
  );
}

function DevicesForm({ initial, onSave, onClose }: { initial: DeviceKind[] | null | undefined; onSave: (kinds: DeviceKind[] | null) => void; onClose: () => void }) {
  const [kinds, setKinds] = useState<DeviceKind[]>(initial ?? []);
  const toggle = (k: DeviceKind, on: boolean) => setKinds(DEVICE_KINDS.filter((x) => (x === k ? on : kinds.includes(x))));
  return (
    <Dialog
      title={t("widget.type.devices")}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={() => onSave(kinds.length === 0 ? null : kinds)}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">{t("widget.devices.filter")}</legend>
        {DEVICE_KINDS.map((k) => (
          <Checkbox key={k} id={`dk-${k}`} label={t(KIND_LABEL[k])} checked={kinds.includes(k)} onChange={(on) => toggle(k, on)} />
        ))}
      </fieldset>
    </Dialog>
  );
}

/** Okno edycji odpowiednie dla typu widgetu. `isNew` zmienia tylko tytuł okna wykresu. */
export function WidgetEditDialog({ widget, isNew = false, onSave, onClose }: { widget: Widget; isNew?: boolean; onSave: (w: Widget) => void; onClose: () => void }) {
  switch (widget.type) {
    case "chart":
      return <ChartForm initial={widget.config} isNew={isNew} onClose={onClose} onSave={(config) => onSave({ ...widget, config })} />;
    case "summary":
      return <SummaryForm initial={widget.config.tiles} onClose={onClose} onSave={(tiles) => onSave({ ...widget, config: { tiles } })} />;
    case "devices":
      return <DevicesForm initial={widget.config.kinds} onClose={onClose} onSave={(kinds) => onSave({ ...widget, config: { kinds } })} />;
  }
}
