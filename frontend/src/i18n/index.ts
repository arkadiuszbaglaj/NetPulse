import { pl, type TextKey } from "./pl";

export type { TextKey };

/** Zwraca tekst interfejsu; `{nazwa}` w tekście jest podmieniane wartością z `vars`. */
export function t(key: TextKey, vars?: Record<string, string | number>): string {
  let text: string = pl[key];
  if (vars) {
    for (const [name, value] of Object.entries(vars)) text = text.replaceAll(`{${name}}`, String(value));
  }
  return text;
}
