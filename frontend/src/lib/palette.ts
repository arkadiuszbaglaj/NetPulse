/** Paleta poleceń (Ctrl+K, od 0.66.0): wyszukiwanie stron, urządzeń, portów i klientów. Czyste funkcje, bez Reacta. */

export type PaletteGroup = "pages" | "devices" | "ports" | "clients";
/** Kolejność grup w wynikach */
export const PALETTE_GROUPS: PaletteGroup[] = ["pages", "devices", "ports", "clients"];

export interface PaletteItem {
  /** Unikalny w całej palecie (klucz Reacta i id opcji) */
  id: string;
  group: PaletteGroup;
  label: string;
  /** Drugi wiersz: adres, urządzenie portu, sieć klienta… */
  detail?: string;
  /** Dodatkowy tekst do wyszukiwania, którego nie pokazujemy (MAC, nazwa techniczna portu) */
  keywords?: string;
  to: string;
}

const LATIN: Record<string, string> = { ł: "l", Ł: "l" };

/** Do porównań: małe litery bez polskich znaków („Łącza” = „lacza”). */
export function normalize(text: string): string {
  return text
    .replace(/[łŁ]/g, (c) => LATIN[c])
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

/** Ocena dopasowania: 0 = brak; wyżej = lepiej (początek nazwy > początek słowa > środek nazwy > opis / słowa kluczowe). */
export function score(item: PaletteItem, words: string[]): number {
  const label = normalize(item.label);
  const rest = normalize(`${item.detail ?? ""} ${item.keywords ?? ""}`);
  let total = 0;
  for (const w of words) {
    const at = label.indexOf(w);
    if (at === 0) total += 4;
    else if (at > 0 && /[\s\-_/.:(]/.test(label[at - 1])) total += 3;
    else if (at > 0) total += 2;
    else if (rest.includes(w)) total += 1;
    else return 0; // każde słowo zapytania musi gdzieś pasować
  }
  return total;
}

export const PER_GROUP = 6;

/**
 * Wyniki dla zapytania, pogrupowane w kolejności `PALETTE_GROUPS`, do `perGroup` na grupę (najlepsze dopasowania,
 * przy remisie krótsza nazwa). Puste zapytanie: same strony i urządzenia – szybkie przejście bez pisania.
 */
export function searchPalette(items: PaletteItem[], query: string, perGroup = PER_GROUP): PaletteItem[] {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  const out: PaletteItem[] = [];
  for (const group of PALETTE_GROUPS) {
    const inGroup = items.filter((i) => i.group === group);
    if (words.length === 0) {
      if (group === "pages" || group === "devices") out.push(...inGroup.slice(0, group === "pages" ? 8 : perGroup));
      continue;
    }
    out.push(
      ...inGroup
        .map((item) => ({ item, s: score(item, words) }))
        .filter((r) => r.s > 0)
        .sort((a, b) => b.s - a.s || a.item.label.length - b.item.label.length)
        .slice(0, perGroup)
        .map((r) => r.item),
    );
  }
  return out;
}
