/** Rejestr widgetów: typ → nazwa, opis, ikona i widok. Nowy typ widgetu = jeden wpis tutaj. */
import {
  IconArrowsExchange,
  IconBolt,
  IconChartBar,
  IconChartLine,
  IconGridDots,
  IconHeading,
  IconLayoutGrid,
  IconListDetails,
  IconNumber,
  IconServer,
  IconShieldCheck,
  IconTable,
  IconTimeline,
  IconWorld,
  type Icon,
} from "@tabler/icons-react";
import { useContext } from "react";
import { t, type TextKey } from "../../i18n";
import type { Widget, WidgetType } from "../../lib/layout";
import { PublicModeContext } from "../../lib/publicMode";
import { ChartWidget, chartTitle } from "./ChartWidget";
import { DevicesWidget } from "./DevicesWidget";
import { HeatmapWidget, heatmapTitle } from "./HeatmapWidget";
import { BarGaugeWidget, StatWidget, StateTimelineWidget, TableWidget, collectionTitle, statTitle, stateTimelineTitle } from "./PanelWidgets";
import { SectionHeader } from "../DashboardGrid";
import { PoeWidget } from "./PoeWidget";
import { ServerWidget } from "./ServerWidget";
import { SummaryWidget } from "./SummaryWidget";
import { WanChartWidget } from "./WanChartWidget";
import { WanSlaWidget } from "./WanSlaWidget";
import { WanStatusWidget } from "./WanStatusWidget";

export const WIDGET_TYPES: { type: WidgetType; label: TextKey; description: TextKey; icon: Icon }[] = [
  { type: "chart", label: "widget.type.chart", description: "widget.type.chart.desc", icon: IconChartLine },
  { type: "stat", label: "widget.type.stat", description: "widget.type.stat.desc", icon: IconNumber },
  { type: "bargauge", label: "widget.type.bargauge", description: "widget.type.bargauge.desc", icon: IconChartBar },
  { type: "table", label: "widget.type.table", description: "widget.type.table.desc", icon: IconTable },
  { type: "state_timeline", label: "widget.type.state_timeline", description: "widget.type.state_timeline.desc", icon: IconTimeline },
  { type: "heatmap", label: "widget.type.heatmap", description: "widget.type.heatmap.desc", icon: IconGridDots },
  { type: "section", label: "widget.type.section", description: "widget.type.section.desc", icon: IconHeading },
  { type: "summary", label: "widget.type.summary", description: "widget.type.summary.desc", icon: IconLayoutGrid },
  { type: "devices", label: "widget.type.devices", description: "widget.type.devices.desc", icon: IconListDetails },
  { type: "poe", label: "widget.type.poe", description: "widget.type.poe.desc", icon: IconBolt },
  { type: "server", label: "widget.type.server", description: "widget.type.server.desc", icon: IconServer },
  { type: "wan_status", label: "widget.type.wan_status", description: "widget.type.wan_status.desc", icon: IconWorld },
  { type: "wan_chart", label: "widget.type.wan_chart", description: "widget.type.wan_chart.desc", icon: IconArrowsExchange },
  { type: "wan_sla", label: "widget.type.wan_sla", description: "widget.type.wan_sla.desc", icon: IconShieldCheck },
];

export function widgetTitle(w: Widget): string {
  switch (w.type) {
    case "chart":
      return chartTitle(w.config);
    case "summary":
      return t("widget.type.summary");
    case "devices":
      return t("widget.type.devices");
    case "poe":
      return t("widget.type.poe");
    case "server":
      return t("widget.type.server");
    case "wan_status":
      return t("widget.type.wan_status");
    case "wan_chart":
      return t("widget.type.wan_chart");
    case "wan_sla":
      return t("widget.type.wan_sla");
    case "stat":
      return statTitle(w.config);
    case "bargauge":
      return w.config.title || collectionTitle(w.config.collection.kind, w.config.key);
    case "table":
      return w.config.title || collectionTitle(w.config.collection.kind);
    case "state_timeline":
      return stateTimelineTitle(w.config);
    case "heatmap":
      return heatmapTitle(w.config);
    case "section":
      return w.config.title || t("widget.type.section");
  }
}

/** Widok widgetu w pulpicie. Na pulpicie publicznym bez trybu „Na żywo” (WebSocket wymaga logowania). */
export function WidgetView({ widget }: { widget: Widget }) {
  const isPublic = useContext(PublicModeContext);
  switch (widget.type) {
    case "chart":
      return <ChartWidget config={widget.config} allowLive={!isPublic} />;
    case "summary":
      return <SummaryWidget tiles={widget.config.tiles} />;
    case "devices":
      return <DevicesWidget kinds={widget.config.kinds} />;
    case "poe":
      return <PoeWidget deviceId={widget.config.device_id} />;
    case "server":
      return <ServerWidget />;
    case "wan_status":
      return <WanStatusWidget deviceId={widget.config.device_id} />;
    case "wan_chart":
      return <WanChartWidget deviceId={widget.config.device_id} metric={widget.config.metric} rangeMin={widget.config.range_min} height={widget.config.height} />;
    case "wan_sla":
      return <WanSlaWidget deviceId={widget.config.device_id} days={widget.config.days} />;
    case "stat":
      return <StatWidget config={widget.config} />;
    case "bargauge":
      return <BarGaugeWidget config={widget.config} />;
    case "table":
      return <TableWidget config={widget.config} />;
    case "state_timeline":
      return <StateTimelineWidget config={widget.config} />;
    case "heatmap":
      return <HeatmapWidget config={widget.config} />;
    case "section":
      return <SectionHeader title={widget.config.title} />;
  }
}
