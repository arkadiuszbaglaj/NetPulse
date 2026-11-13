/** Formatery `Intl` w bieżącym języku panelu (od 0.74.0). Stałe modułów tworzą je raz, a język jest sprawdzany
 * przy każdym formatowaniu – zamiast `new Intl.DateTimeFormat("pl", …)`. */
import { locale } from "../i18n";

const cache = new Map<string, Intl.DateTimeFormat | Intl.NumberFormat>();

function cached<T extends Intl.DateTimeFormat | Intl.NumberFormat>(kind: string, opts: object, make: (loc: string) => T): T {
  const key = `${kind}|${locale()}|${JSON.stringify(opts)}`;
  let f = cache.get(key) as T | undefined;
  if (!f) {
    f = make(locale());
    cache.set(key, f);
  }
  return f;
}

export interface DateFormatter {
  format: (d: Date | number) => string;
  formatRange: (a: Date | number, b: Date | number) => string;
}

export interface NumberFormatter {
  format: (n: number) => string;
}

export function dateFormat(opts: Intl.DateTimeFormatOptions): DateFormatter {
  const f = () => cached("d", opts, (loc) => new Intl.DateTimeFormat(loc, opts));
  return { format: (d) => f().format(d), formatRange: (a, b) => f().formatRange(a, b) };
}

export function numberFormat(opts: Intl.NumberFormatOptions = {}): NumberFormatter {
  return { format: (n) => cached("n", opts, (loc) => new Intl.NumberFormat(loc, opts)).format(n) };
}

/** Liczba w bieżącym języku (skrót dla jednorazowych miejsc). */
export function formatNumber(n: number, opts: Intl.NumberFormatOptions = {}): string {
  return numberFormat(opts).format(n);
}
