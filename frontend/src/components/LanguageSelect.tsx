import { useState } from "react";
import { browserLanguage, languagePreference, LANGUAGES, setLanguage, t, type Language } from "../i18n";
import { Select } from "./ui";

/** Wybór języka panelu (zapamiętany w przeglądarce, jak motyw). Zmiana przeładowuje panel. `compact` – na stronie
 * logowania: sama lista bez podpowiedzi. */
export function LanguageSelect({ compact = false }: { compact?: boolean }) {
  const [value, setValue] = useState<Language | "auto">(languagePreference() ?? "auto");
  const onChange = (next: string) => {
    setValue(next as Language | "auto");
    setLanguage(next === "auto" ? null : (next as Language));
  };
  const auto = t("lang.auto", { lang: t(`lang.${browserLanguage()}`) });
  if (compact)
    return (
      <label className="inline-flex items-center gap-2 text-xs text-text-2">
        <span className="sr-only">{t("lang.label")}</span>
        <select
          aria-label={t("lang.label")}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="rounded-md border border-border bg-surface px-2 py-1 text-xs text-text"
        >
          <option value="auto">{auto}</option>
          {LANGUAGES.map((l) => (
            <option key={l} value={l}>
              {t(`lang.${l}`)}
            </option>
          ))}
        </select>
      </label>
    );
  return (
    <div className="flex flex-col gap-2">
      <Select id="language" label={t("lang.label")} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="auto">{auto}</option>
        {LANGUAGES.map((l) => (
          <option key={l} value={l}>
            {t(`lang.${l}`)}
          </option>
        ))}
      </Select>
      <p className="text-xs text-text-2">{t("lang.hint")}</p>
    </div>
  );
}
