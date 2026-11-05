import { IconCheck, IconChevronDown, IconClock, IconZoomOut } from "@tabler/icons-react";
import { useRef, useState } from "react";
import { t } from "../i18n";
import { formatRange } from "../lib/format";
import { RANGE_OPTIONS, useRefresh } from "../lib/refresh";
import { useDismiss } from "../lib/useDismiss";

const zoomFmt = new Intl.DateTimeFormat("pl", { dateStyle: "short", timeStyle: "short" });

/** Wybór zakresu czasu wykresów (ustawienie globalne, zapamiętywane w przeglądarce) – rozwijane menu (od 0.42.1).
 * Przy powiększonym fragmencie pokazuje jego czas i „Wróć”; wybór zakresu kończy powiększenie. */
export function RangePicker() {
  const { rangeMinutes, setRangeMinutes, zoom, zoomOut } = useRefresh();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useDismiss(open, () => setOpen(false), root, trigger);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {zoom && (
        <button
          type="button"
          onClick={zoomOut}
          title={t("zoom.out.hint")}
          className="inline-flex items-center gap-1.5 rounded-lg border border-accent bg-accent-soft px-2.5 py-1 text-xs text-accent-text hover:bg-accent/20"
        >
          <IconZoomOut size={14} aria-hidden="true" />
          <span>
            {t("zoom.out")} <span className="tabular-nums">({zoomFmt.formatRange(new Date(zoom.from), new Date(zoom.to))})</span>
          </span>
        </button>
      )}
      <div ref={root} className="relative">
        <button
          ref={trigger}
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`${t("dash.range")}: ${formatRange(rangeMinutes)}`}
          onClick={() => setOpen((v) => !v)}
          className="inline-flex h-9 items-center gap-2 rounded-lg border border-border-strong bg-surface px-3 text-sm font-medium text-text hover:bg-surface-2"
        >
          <IconClock size={16} aria-hidden="true" className="text-text-2" />
          {zoom ? t("dash.range") : formatRange(rangeMinutes)}
          <IconChevronDown size={15} aria-hidden="true" className="text-text-2" />
        </button>

        {open && (
          <div
            role="menu"
            aria-label={t("dash.range")}
            className="absolute right-0 top-full z-30 mt-2 w-48 overflow-hidden rounded-xl border border-border bg-surface py-1 shadow-lg"
          >
            {RANGE_OPTIONS.map((m) => {
              const checked = !zoom && m === rangeMinutes;
              return (
                <button
                  key={m}
                  type="button"
                  role="menuitemradio"
                  aria-checked={checked}
                  onClick={() => {
                    setRangeMinutes(m);
                    setOpen(false);
                  }}
                  className="flex w-full items-center justify-between px-3 py-2 text-left text-sm text-text hover:bg-surface-2 focus-visible:bg-surface-2"
                >
                  {formatRange(m)}
                  {checked && <IconCheck size={16} aria-hidden="true" className="text-accent-text" />}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
