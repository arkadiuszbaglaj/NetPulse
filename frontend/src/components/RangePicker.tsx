import { IconZoomOut } from "@tabler/icons-react";
import { t } from "../i18n";
import { formatRange } from "../lib/format";
import { RANGE_OPTIONS, useRefresh } from "../lib/refresh";

const zoomFmt = new Intl.DateTimeFormat("pl", { dateStyle: "short", timeStyle: "short" });

/** Wybór zakresu czasu wykresów (ustawienie globalne, zapamiętywane w przeglądarce). Przy powiększonym fragmencie
 * pokazuje jego czas i „Wróć”; wybór zakresu kończy powiększenie. */
export function RangePicker() {
  const { rangeMinutes, setRangeMinutes, zoom, zoomOut } = useRefresh();
  return (
    <div className="flex flex-wrap items-center gap-2">
      {zoom && (
        <button
          type="button"
          onClick={zoomOut}
          title={t("zoom.out.hint")}
          className="inline-flex items-center gap-1.5 rounded-lg border border-accent bg-accent-soft px-2.5 py-1 text-xs text-accent hover:bg-accent/20"
        >
          <IconZoomOut size={14} aria-hidden="true" />
          <span>
            {t("zoom.out")} <span className="tabular-nums">({zoomFmt.formatRange(new Date(zoom.from), new Date(zoom.to))})</span>
          </span>
        </button>
      )}
      <div role="group" aria-label={t("dash.range")} className="inline-flex flex-wrap rounded-lg border border-border bg-surface p-0.5">
        {RANGE_OPTIONS.map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={!zoom && m === rangeMinutes}
            onClick={() => setRangeMinutes(m)}
            className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
              !zoom && m === rangeMinutes ? "bg-accent-soft font-medium text-accent" : "text-text-2 hover:text-text"
            }`}
          >
            {formatRange(m)}
          </button>
        ))}
      </div>
    </div>
  );
}
