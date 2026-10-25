/** Rejestr widgetów: typ → nazwa, opis, ikona i widok. Nowy typ widgetu = jeden wpis tutaj. */
import { IconBolt, IconChartLine, IconLayoutGrid, IconListDetails, IconServer, type Icon } from "@tabler/icons-react";
import { t, type TextKey } from "../../i18n";
import type { Widget, WidgetType } from "../../lib/layout";
import { ChartWidget } from "./ChartWidget";
import { defaultTitle } from "./chartSource";
import { DevicesWidget } from "./DevicesWidget";
import { PoeWidget } from "./PoeWidget";
import { ServerWidget } from "./ServerWidget";
import { SummaryWidget } from "./SummaryWidget";

export const WIDGET_TYPES: { type: WidgetType; label: TextKey; description: TextKey; icon: Icon }[] = [
  { type: "chart", label: "widget.type.chart", description: "widget.type.chart.desc", icon: IconChartLine },
  { type: "summary", label: "widget.type.summary", description: "widget.type.summary.desc", icon: IconLayoutGrid },
  { type: "devices", label: "widget.type.devices", description: "widget.type.devices.desc", icon: IconListDetails },
  { type: "poe", label: "widget.type.poe", description: "widget.type.poe.desc", icon: IconBolt },
  { type: "server", label: "widget.type.server", description: "widget.type.server.desc", icon: IconServer },
];

export function widgetTitle(w: Widget): string {
  switch (w.type) {
    case "chart":
      return w.config.title || defaultTitle(w.config.source);
    case "summary":
      return t("widget.type.summary");
    case "devices":
      return t("widget.type.devices");
    case "poe":
      return t("widget.type.poe");
    case "server":
      return t("widget.type.server");
  }
}

/** Widok widgetu w pulpicie. */
export function WidgetView({ widget }: { widget: Widget }) {
  switch (widget.type) {
    case "chart":
      return <ChartWidget config={widget.config} allowLive />;
    case "summary":
      return <SummaryWidget tiles={widget.config.tiles} />;
    case "devices":
      return <DevicesWidget kinds={widget.config.kinds} />;
    case "poe":
      return <PoeWidget deviceId={widget.config.device_id} />;
    case "server":
      return <ServerWidget />;
  }
}
