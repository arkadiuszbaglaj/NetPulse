/** Ocena hasła dla podpowiedzi w formularzach. Lista warunków i progi są tutaj, w jednym miejscu.
 * To tylko wskazówka: twarda reguła (min. 8 znaków) jest w `MIN_PASSWORD` i w backendzie. */
import type { TextKey } from "../i18n";

export const MIN_PASSWORD = 8;
export const RECOMMENDED_PASSWORD = 12;

export interface PasswordRule {
  id: "length" | "recommended" | "lower" | "upper" | "digit" | "special";
  label: TextKey;
  /** Warunek wymagany (blokuje wysłanie formularza); pozostałe są zaleceniami. */
  required?: boolean;
  test: (password: string) => boolean;
}

export const PASSWORD_RULES: PasswordRule[] = [
  { id: "length", label: "password.rule.length", required: true, test: (p) => p.length >= MIN_PASSWORD },
  { id: "recommended", label: "password.rule.recommended", test: (p) => p.length >= RECOMMENDED_PASSWORD },
  { id: "lower", label: "password.rule.lower", test: (p) => /\p{Ll}/u.test(p) },
  { id: "upper", label: "password.rule.upper", test: (p) => /\p{Lu}/u.test(p) },
  { id: "digit", label: "password.rule.digit", test: (p) => /\d/.test(p) },
  { id: "special", label: "password.rule.special", test: (p) => /[^\p{L}\d\s]/u.test(p) },
];

export type PasswordStrength = "none" | "weak" | "fair" | "good" | "strong";

export interface PasswordReport {
  results: { rule: PasswordRule; ok: boolean }[];
  /** Ile warunków jest spełnionych (0–6). */
  passed: number;
  strength: PasswordStrength;
}

/** Siła: zła, gdy brakuje minimalnej długości; dalej według liczby spełnionych warunków.
 * Długie hasło z samych słów (12+ znaków) też jest „dobre”, bo długość waży więcej niż rodzaje znaków. */
export function evaluatePassword(password: string): PasswordReport {
  const results = PASSWORD_RULES.map((rule) => ({ rule, ok: rule.test(password) }));
  const passed = results.filter((r) => r.ok).length;
  let strength: PasswordStrength;
  if (password.length === 0) strength = "none";
  else if (password.length < MIN_PASSWORD) strength = "weak";
  else if (password.length >= 16 || passed >= 6) strength = "strong";
  else if (password.length >= RECOMMENDED_PASSWORD || passed >= 5) strength = "good";
  else if (passed >= 4) strength = "fair";
  else strength = "weak";
  return { results, passed, strength };
}
