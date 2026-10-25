/** Okna edycji widgetów: wykres (ChartEditor), podsumowanie (kafelki), karty urządzeń (filtr), PoE i łącza WAN. */
import { useState } from "react";
import { t, type TextKey } from "../../i18n";
import { type Device } from "../../lib/api";
import {
  DEVICE_KINDS,
  SUMMARY_TILES,
  type ChartHeight,
  type DeviceKind,
  type SummaryTile,
  type WanChartWidgetModel,
  type WanMetric,
  type WanSlaWidgetModel,
  type WanStatusWidgetModel,
  type Widget,
} from "../../lib/layout";
import { SLA_DAYS, type SlaDays } from "../../lib/wan";
import { useDevices } from "../../lib/queries";
import { formatRange } from "../../lib/format";
import { RANGE_OPTIONS, type RangeMinutes } from "../../lib/refresh";
import { Dialog } from "../Dialog";
import { Button, Select } from "../ui";
import { ChartEditor } from "./ChartEditor";
import { BarGaugeForm, StatForm, StateTimelineForm, TableForm } from "./PanelEditors";
import { KIND_LABEL } from "./DevicesWidget";

const TILE_LABEL: Record<SummaryTile, TextKey> = {
  devices: "widget.tile.devices",
  wan_down: "widget.tile.wan_down",
  wan_up: "widget.tile.wan_up",
  wifi_clients: "widget.tile.wifi_clients",
};
const HEIGHTS: ChartHeight[] = ["sm", "md", "lg"];

function Checkbox({ id, label, checked, onChange }: { id: string; label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label htmlFor={id} className="flex items-center gap-2 text-sm">
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="size-4 accent-accent" />
      {label}
    </label>
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

function PoeForm({ initial, onSave, onClose }: { initial: number | null | undefined; onSave: (deviceId: number | null) => void; onClose: () => void }) {
  const devices = useDevices();
  const [deviceId, setDeviceId] = useState<number | null>(initial ?? null);
  const switches = (devices.data ?? []).filter((d: Device) => d.kind === "switch");
  return (
    <Dialog
      title={t("widget.type.poe")}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={() => onSave(deviceId)}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <Select id="poe-device" label={t("widget.poe.device")} value={deviceId ?? ""} onChange={(e) => setDeviceId(e.target.value ? Number(e.target.value) : null)}>
        <option value="">{t("widget.poe.all")}</option>
        {switches.map((d: Device) => (
          <option key={d.id} value={d.id}>
            {d.name}
          </option>
        ))}
      </Select>
    </Dialog>
  );
}

/** Karta serwera nie ma ustawień – okno tylko wyjaśnia, skąd bierze dane. */
function ServerInfo({ isNew, onSave, onClose }: { isNew: boolean; onSave: () => void; onClose: () => void }) {
  return (
    <Dialog
      title={t("widget.type.server")}
      size="sm"
      onClose={onClose}
      footer={
        isNew ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" onClick={onSave}>
              {t("widget.add.title")}
            </Button>
          </>
        ) : (
          <Button variant="primary" onClick={onClose}>
            {t("common.close")}
          </Button>
        )
      }
    >
      <p className="text-sm text-text-2">{t("widget.server.info")}</p>
    </Dialog>
  );
}

// --- łącza WAN ----------------------------------------------------------------------------------

type WanWidget = WanStatusWidgetModel | WanChartWidgetModel | WanSlaWidgetModel;

/** Widgety WAN: router (puste = wszystkie), dla wykresu metryka, zakres i wysokość, dla SLA okres. */
function WanForm({ initial, isNew, onSave, onClose }: { initial: WanWidget; isNew: boolean; onSave: (w: Widget) => void; onClose: () => void }) {
  const devices = useDevices();
  const [widget, setWidget] = useState<WanWidget>(initial);
  const routers = (devices.data ?? []).filter((d: Device) => d.kind === "gateway");
  type WanPatch = Partial<WanChartWidgetModel["config"]> | Partial<WanSlaWidgetModel["config"]>;
  const setConfig = (patch: WanPatch) => setWidget((w) => ({ ...w, config: { ...w.config, ...patch } }) as WanWidget);
  return (
    <Dialog
      title={t(`widget.type.${widget.type}` as TextKey)}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={() => onSave(widget)}>
            {t(isNew ? "widget.add.title" : "common.save")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-text-2">{t("widget.wan.info")}</p>
        <Select
          id="wan-device"
          label={t("widget.wan.device")}
          value={widget.config.device_id ?? ""}
          onChange={(e) => setConfig({ device_id: e.target.value ? Number(e.target.value) : null })}
        >
          <option value="">{t("widget.wan.all")}</option>
          {routers.map((d: Device) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </Select>
        {widget.type === "wan_chart" && (
          <>
            <Select id="wan-metric" label={t("widget.wan.metric")} value={widget.config.metric} onChange={(e) => setConfig({ metric: e.target.value as WanMetric })}>
              <option value="in_bps">{t("chart.traffic.in")}</option>
              <option value="out_bps">{t("chart.traffic.out")}</option>
            </Select>
            <Select
              id="wan-range"
              label={t("ce.range")}
              value={widget.config.range_min ?? ""}
              onChange={(e) => setConfig({ range_min: e.target.value ? (Number(e.target.value) as RangeMinutes) : null })}
            >
              <option value="">{t("ce.range.global")}</option>
              {RANGE_OPTIONS.map((m) => (
                <option key={m} value={m}>
                  {formatRange(m)}
                </option>
              ))}
            </Select>
            <Select id="wan-height" label={t("ce.height")} value={widget.config.height} onChange={(e) => setConfig({ height: e.target.value as ChartHeight })}>
              {HEIGHTS.map((h) => (
                <option key={h} value={h}>
                  {t(`ce.height.${h}` as TextKey)}
                </option>
              ))}
            </Select>
          </>
        )}
        {widget.type === "wan_sla" && (
          <Select id="wan-days" label={t("wan.sla.period")} value={widget.config.days} onChange={(e) => setConfig({ days: Number(e.target.value) as SlaDays })}>
            {SLA_DAYS.map((d) => (
              <option key={d} value={d}>
                {t(`wan.sla.days.${d}` as TextKey)}
              </option>
            ))}
          </Select>
        )}
      </div>
    </Dialog>
  );
}

/** Okno edycji odpowiednie dla typu widgetu. `isNew` zmienia tylko tytuł okna wykresu. */
export function WidgetEditDialog({ widget, isNew = false, onSave, onClose }: { widget: Widget; isNew?: boolean; onSave: (w: Widget) => void; onClose: () => void }) {
  switch (widget.type) {
    case "chart":
      return <ChartEditor initial={widget.config} isNew={isNew} onClose={onClose} onSave={(config) => onSave({ ...widget, config })} />;
    case "summary":
      return <SummaryForm initial={widget.config.tiles} onClose={onClose} onSave={(tiles) => onSave({ ...widget, config: { tiles } })} />;
    case "devices":
      return <DevicesForm initial={widget.config.kinds} onClose={onClose} onSave={(kinds) => onSave({ ...widget, config: { kinds } })} />;
    case "server":
      return <ServerInfo isNew={isNew} onClose={onClose} onSave={() => onSave(widget)} />;
    case "poe":
      return <PoeForm initial={widget.config.device_id} onClose={onClose} onSave={(device_id) => onSave({ ...widget, config: { device_id } })} />;
    case "wan_status":
    case "wan_chart":
    case "wan_sla":
      return <WanForm initial={widget} isNew={isNew} onClose={onClose} onSave={onSave} />;
    case "stat":
      return <StatForm initial={widget.config} isNew={isNew} onClose={onClose} onSave={(config) => onSave({ ...widget, config })} />;
    case "bargauge":
      return <BarGaugeForm initial={widget.config} isNew={isNew} onClose={onClose} onSave={(config) => onSave({ ...widget, config })} />;
    case "table":
      return <TableForm initial={widget.config} isNew={isNew} onClose={onClose} onSave={(config) => onSave({ ...widget, config })} />;
    case "state_timeline":
      return <StateTimelineForm initial={widget.config} isNew={isNew} onClose={onClose} onSave={(config) => onSave({ ...widget, config })} />;
  }
}
