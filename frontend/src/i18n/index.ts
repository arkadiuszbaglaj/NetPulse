import { en } from "./en";
import { pl, type TextKey } from "./pl";

export type { TextKey };

/** Języki panelu (od 0.74.0). Nowy język = plik z tymi samymi kluczami (`Record<TextKey, string>`) i wpis tutaj. */
export const LANGUAGES = ["pl", "en"] as const;
export type Language = (typeof LANGUAGES)[number];

const TEXTS: Record<Language, Record<TextKey, string>> = { pl, en };
/** Ustawienia regionalne dat i liczb: angielski z 24-godzinnym zegarem i datą dzień/miesiąc (en-GB). */
const LOCALES: Record<Language, string> = { pl: "pl-PL", en: "en-GB" };
const KEY = "netpulse.language";

/** Język z przeglądarki: polski dla `pl*`, w pozostałych przypadkach angielski. */
export function browserLanguage(): Language {
  const list = typeof navigator === "undefined" ? [] : navigator.languages?.length ? navigator.languages : [navigator.language];
  return list.some((l) => l?.toLowerCase().startsWith("pl")) ? "pl" : "en";
}

function stored(): Language | null {
  try {
    const v = localStorage.getItem(KEY);
    return (LANGUAGES as readonly string[]).includes(v ?? "") ? (v as Language) : null;
  } catch {
    return null; // localStorage może być zablokowany
  }
}

let current: Language = stored() ?? browserLanguage();

function applyDocument() {
  if (typeof document !== "undefined") document.documentElement.lang = current;
}
applyDocument();

export function getLanguage(): Language {
  return current;
}

/** Wybrany wprost język (null = według przeglądarki). */
export function languagePreference(): Language | null {
  return stored();
}

/** Ustawia język i zapamiętuje go w przeglądarce (null = według przeglądarki). Panel przeładowuje się po zmianie
 * (`reload`), bo teksty są czytane przy renderowaniu i w stałych modułów. */
export function setLanguage(lang: Language | null, { reload = true }: { reload?: boolean } = {}): void {
  try {
    if (lang) localStorage.setItem(KEY, lang);
    else localStorage.removeItem(KEY);
  } catch {
    /* bez zapamiętywania – język działa do końca sesji */
  }
  const next = lang ?? browserLanguage();
  const changed = next !== current;
  current = next;
  applyDocument();
  if (reload && changed && typeof window !== "undefined") window.location.reload();
}

/** Ustawienia regionalne bieżącego języka dla `Intl` i `toLocaleString`. */
export function locale(): string {
  return LOCALES[current];
}

/** Zwraca tekst interfejsu; `{nazwa}` w tekście jest podmieniane wartością z `vars`. */
export function t(key: TextKey, vars?: Record<string, string | number>): string {
  let text: string = TEXTS[current][key] ?? pl[key];
  if (vars) {
    for (const [name, value] of Object.entries(vars)) text = text.replaceAll(`{${name}}`, String(value));
  }
  return text;
}
