import { describe, expect, it } from "vitest";
import type { LegendConfig } from "../../lib/layout";
import { fitLegend, plotSizeClass } from "./legendFit";

const table: LegendConfig = { mode: "table", placement: "bottom", values: ["last", "max", "avg"] };
const list: LegendConfig = { mode: "list", placement: "bottom", values: [] };
const compact: LegendConfig = { mode: "list", placement: "bottom", values: [] };

describe("fitLegend – legenda ustępuje miejsca wykresowi", () => {
  it("bez pomiaru albo z legendą ukrytą – bez zmian", () => {
    expect(fitLegend(table, 4, null)).toBe(table);
    const hidden: LegendConfig = { ...table, mode: "hidden" };
    expect(fitLegend(hidden, 4, { width: 200, height: 100 })).toBe(hidden);
  });

  it("duża karta zostawia tabelę pod wykresem", () => {
    expect(fitLegend(table, 4, { width: 1080, height: 500 })).toEqual(table);
  });

  it("szeroka, niska karta przenosi tabelę na prawo", () => {
    // 4 serie: tabela ~124 px, wykres zostałby z ~100 px
    expect(fitLegend(table, 4, { width: 1080, height: 230 })).toEqual({ ...table, placement: "right" });
  });

  it("wąska i niska karta zwija tabelę do samych nazw", () => {
    expect(fitLegend(table, 4, { width: 520, height: 230 })).toEqual(compact);
    expect(fitLegend(table, 2, { width: 240, height: 130 })).toEqual(compact);
  });

  it("bardzo mała karta chowa legendę", () => {
    expect(fitLegend(table, 4, { width: 240, height: 84 })).toEqual({ ...table, mode: "hidden" });
  });

  it("ustawienie „po prawej” zostaje, gdy jest miejsce; w wąskiej karcie legenda schodzi pod wykres", () => {
    const right: LegendConfig = { ...list, placement: "right" };
    expect(fitLegend(right, 3, { width: 900, height: 200 })).toBe(right);
    expect(fitLegend(right, 3, { width: 400, height: 300 })).toEqual({ ...list, placement: "bottom" });
  });

  it("lista z wartościami liczy wiersze z szerokości", () => {
    const withValues: LegendConfig = { mode: "list", placement: "bottom", values: ["last"] };
    // 2 serie w jednym wierszu (szerokość 600) – 20 px legendy, wykres ma miejsce
    expect(fitLegend(withValues, 2, { width: 600, height: 180 })).toEqual(withValues);
  });
});

describe("plotSizeClass – progi przeliczania osi", () => {
  it("klasy szerokości i wysokości", () => {
    expect(plotSizeClass(300, 100)).toBe("xss");
    expect(plotSizeClass(500, 200)).toBe("sm");
    expect(plotSizeClass(900, 400)).toBe("ml");
  });
});
