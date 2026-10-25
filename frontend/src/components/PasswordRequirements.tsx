import { IconCheck, IconX } from "@tabler/icons-react";
import { t, type TextKey } from "../i18n";
import { evaluatePassword, type PasswordStrength } from "../lib/password";

const STRENGTH: Record<PasswordStrength, { label: TextKey; bars: number; color: string }> = {
  none: { label: "password.strength.none", bars: 0, color: "bg-border-strong" },
  weak: { label: "password.strength.weak", bars: 1, color: "bg-danger" },
  fair: { label: "password.strength.fair", bars: 2, color: "bg-warning" },
  good: { label: "password.strength.good", bars: 3, color: "bg-accent" },
  strong: { label: "password.strength.strong", bars: 4, color: "bg-success" },
};

/** Podpowiedź pod polem hasła: pasek siły i lista warunków (✓/✗ plus tekst, nie tylko kolor). */
export function PasswordRequirements({ password, id }: { password: string; id: string }) {
  const { results, strength } = evaluatePassword(password);
  const s = STRENGTH[strength];
  return (
    <div id={id} className="flex flex-col gap-2 text-xs">
      <div className="flex items-center gap-2">
        <div aria-hidden="true" className="flex flex-1 gap-1">
          {[1, 2, 3, 4].map((i) => (
            <span key={i} className={`h-1.5 flex-1 rounded-full ${i <= s.bars ? s.color : "bg-surface-2"}`} />
          ))}
        </div>
        <span className="w-24 text-right text-text-2">{t(s.label)}</span>
      </div>
      <ul aria-live="polite" aria-label={t("password.rules")} className="flex flex-col gap-0.5">
        {results.map(({ rule, ok }) => (
          <li key={rule.id} className={`flex items-center gap-1.5 ${ok ? "text-success" : "text-text-2"}`}>
            {ok ? <IconCheck size={14} aria-hidden="true" /> : <IconX size={14} aria-hidden="true" />}
            <span>{t(rule.label)}</span>
            <span className="sr-only">{ok ? t("password.rule.ok") : t("password.rule.missing")}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
