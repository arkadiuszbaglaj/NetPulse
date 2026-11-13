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
      {/* Podpis od 400 px (większość telefonów); węższy ekran – sama kropka z nazwą dla czytnika ekranu */}
      <span className="hidden min-[400px]:inline">{t(on ? "live.toggle.on" : "live.toggle.off")}</span>
      <span className="sr-only min-[400px]:hidden">{t("live.toggle.label")}</span>
    </button>
  );
}
