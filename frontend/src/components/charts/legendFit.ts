/** Legenda wykresu w karcie pulpitu (od 0.53.0): ustępuje miejsca wykresowi, gdy karta jest mała.
 *
 * Kolejność: legenda jak w ustawieniach → ta sama legenda po prawej (szeroka, niska karta) → zwarta lista
 * (kropka i nazwa, bez wartości) → bez legendy (nazwy serii zostają w podpowiedzi). Pełna tabela zostaje w dużej karcie
 * i w trybie pełnego ekranu. */
import { useEffect, useState } from "react";
import type { LegendConfig } from "../../lib/layout";

/** Najmniejsza wysokość wykresu z legendą pod spodem, przy której legenda zostaje jak w ustawieniach */
export const MIN_PLOT_HEIGHT = 140;
/** Najmniejsza szerokość wykresu, gdy legenda stoi obok (szerokość legendy po prawej: `w-64`) */
export const MIN_PLOT_WIDTH = 360;
/** Najmniejsza wysokość wykresu ze zwartą listą; niżej legenda znika */
export const MIN_COMPACT_PLOT = 70;
const RIGHT_GAP = 12;
const TABLE_HEAD = 24;
const TABLE_ROW = 25;
const LIST_ROW = 20;
const GAP = 8;

export interface Box {
  width: number;
  height: number;
}

/** Wysokość legendy-listy: pozycje w wierszach (ok. 150 px na nazwę i 70 px na każdą wartość) */
function listHeight(items: number, values: number, width: number): number {
  const perRow = Math.max(1, Math.floor(width / (150 + values * 70)));
  return Math.ceil(items / perRow) * LIST_ROW;
}

/** Szerokość legendy po prawej (od 0.54.2): lista i tabela z jedną wartością – 256 px, tabela z większą liczbą
 * kolumn szersza (ok. 120 px na nazwę i 80 px na kolumnę), żeby nazwy nie nachodziły na wartości. */
export function rightLegendWidth(legend: LegendConfig): number {
  return legend.mode === "table" ? Math.max(256, 120 + legend.values.length * 80) : 256;
}

export function fitLegend(legend: LegendConfig, items: number, box: Box | null): LegendConfig {
  if (!box || box.width <= 0 || box.height <= 0 || legend.mode === "hidden" || items === 0) return legend;
  const sideBySide = box.width - rightLegendWidth(legend) - RIGHT_GAP >= MIN_PLOT_WIDTH;
  if (legend.placement === "right" && sideBySide) return legend;
  const below = legend.mode === "table" ? TABLE_HEAD + items * TABLE_ROW : listHeight(items, legend.values.length, box.width);
  if (box.height - below - GAP >= MIN_PLOT_HEIGHT) return { ...legend, placement: "bottom" };
  if (sideBySide) return { ...legend, placement: "right" };
  if (box.height - listHeight(items, 0, box.width) - GAP >= MIN_COMPACT_PLOT) return { mode: "list", placement: "bottom", values: [] };
  return { ...legend, mode: "hidden" };
}

/** Rozmiar elementu (ResizeObserver); `null`, dopóki element nie jest zamontowany albo pomiar jest wyłączony. */
export function useBoxSize(el: HTMLElement | null, enabled: boolean): Box | null {
  const [box, setBox] = useState<Box | null>(null);
  useEffect(() => {
    if (!enabled || !el) return;
    const update = () => setBox((b) => (b && b.width === el.clientWidth && b.height === el.clientHeight ? b : { width: el.clientWidth, height: el.clientHeight }));
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el, enabled]);
  return enabled ? box : null;
}

/** Progi, od których zmieniają się opcje osi (liczba podziałek, czcionka) – wykres przelicza opcje tylko po zmianie klasy. */
export function plotSizeClass(width: number, height: number): string {
  const w = width < 360 ? "xs" : width < 560 ? "s" : "m";
  const h = height < 170 ? "s" : height < 240 ? "m" : "l";
  return `${w}${h}`;
}
