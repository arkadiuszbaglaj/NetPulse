import { setLiveEnabled, useLiveEnabled } from "../lib/liveHub";
import { t } from "../i18n";

/** Pasek górny: włącza i wstrzymuje dane na żywo (wartości co ~1,5 s zamiast co 30 s). */
export function LiveToggle() {
  const on = useLiveEnabled();
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={() => setLiveEnabled(!on)}
      title={t(on ? "live.toggle.on.hint" : "live.toggle.off.hint")}
      className="flex h-9 items-center gap-1.5 rounded-lg px-2 text-sm text-text-2 hover:bg-surface-2 hover:text-text"
    >
      <span aria-hidden="true" className={`size-2 rounded-full ${on ? "animate-pulse bg-success" : "border border-border-strong"}`} />
      <span className="hidden sm:inline">{t(on ? "live.toggle.on" : "live.toggle.off")}</span>
      <span className="sr-only sm:hidden">{t("live.toggle.label")}</span>
    </button>
  );
}
