import { t } from "../i18n";
import { formatRange } from "../lib/format";
import { RANGE_OPTIONS, useRefresh } from "../lib/refresh";

/** Wybór zakresu czasu wykresów (ustawienie globalne, zapamiętywane w przeglądarce). */
export function RangePicker() {
  const { rangeMinutes, setRangeMinutes } = useRefresh();
  return (
    <div role="group" aria-label={t("dash.range")} className="inline-flex flex-wrap rounded-lg border border-border bg-surface p-0.5">
      {RANGE_OPTIONS.map((m) => (
        <button
          key={m}
          type="button"
          aria-pressed={m === rangeMinutes}
          onClick={() => setRangeMinutes(m)}
          className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
            m === rangeMinutes ? "bg-accent-soft font-medium text-accent" : "text-text-2 hover:text-text"
          }`}
        >
          {formatRange(m)}
        </button>
      ))}
    </div>
  );
}
