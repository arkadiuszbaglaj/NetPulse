import { t } from "../../i18n";
import type { LegendConfig, LegendValue } from "../../lib/layout";
import type { LineStats, PanelLine } from "./panelData";

export interface LegendItem {
  line: PanelLine;
  stats: LineStats;
  format: (value: number) => string;
  hidden: boolean;
}

const VALUE_LABEL: Record<LegendValue, Parameters<typeof t>[0]> = {
  last: "chart.legend.last",
  min: "chart.legend.min",
  max: "chart.legend.max",
  avg: "chart.legend.avg",
};

function Swatch({ line }: { line: PanelLine }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block h-1 w-3.5 shrink-0 rounded-full ${line.dashed ? "opacity-60" : ""}`}
      style={{ backgroundColor: `var(--chart-${line.color})` }}
    />
  );
}

/** Legenda wykresu: lista albo tabela z min / max / średnią / ostatnią. Klik ukrywa i pokazuje serię. */
export function ChartLegend({ items, config, onToggle }: { items: LegendItem[]; config: LegendConfig; onToggle: (id: string) => void }) {
  if (config.mode === "hidden" || items.length === 0) return null;
  const value = (item: LegendItem, v: LegendValue) => (item.stats[v] == null ? "–" : item.format(item.stats[v]));
  const toggle = (item: LegendItem) => (
    <button
      type="button"
      aria-pressed={!item.hidden}
      title={t(item.hidden ? "chart.legend.show" : "chart.legend.hide")}
      onClick={() => onToggle(item.line.id)}
      className={`flex min-w-0 items-center gap-1.5 rounded px-1 text-left hover:bg-surface-2 ${item.hidden ? "text-muted line-through" : ""}`}
    >
      <Swatch line={item.line} />
      <span className="truncate">{item.line.name}</span>
    </button>
  );

  if (config.mode === "table") {
    return (
      <table aria-label={t("chart.legend")} className="w-full min-w-0 text-left text-xs">
        <thead className="text-text-2">
          <tr>
            <th scope="col" className="py-1 font-medium">
              <span className="sr-only">{t("chart.legend.series")}</span>
            </th>
            {config.values.map((v) => (
              <th key={v} scope="col" className="py-1 pl-3 text-right font-medium">
                {t(VALUE_LABEL[v])}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.line.id} className="border-t border-border">
              <td className="max-w-0 py-1">{toggle(item)}</td>
              {config.values.map((v) => (
                <td key={v} className={`py-1 pl-3 text-right tabular-nums ${item.hidden ? "text-muted" : ""}`}>
                  {value(item, v)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  return (
    <ul aria-label={t("chart.legend")} className={`flex gap-x-3 gap-y-1 text-xs ${config.placement === "right" ? "flex-col" : "flex-wrap"}`}>
      {items.map((item) => (
        <li key={item.line.id} className="flex min-w-0 items-center gap-2">
          {toggle(item)}
          {config.values.map((v) => (
            <span key={v} className="shrink-0 tabular-nums text-text-2">
              {t(VALUE_LABEL[v]).toLowerCase()} {value(item, v)}
            </span>
          ))}
        </li>
      ))}
    </ul>
  );
}
