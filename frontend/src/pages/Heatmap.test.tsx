import { screen, within } from "@testing-library/react";
import type { SeriesPoint } from "../lib/api";
import { heatmapGrid, intensity, weekday } from "../lib/heatmap";
import { newWidget, type DashboardLayout } from "../lib/layout";
import { mockApi } from "../test/mockApi";
import { renderApp } from "../test/renderApp";

// Czas lokalny (godziny mapy są w strefie przeglądarki): środa 28.10.2026 i czwartek 29.10.2026
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).toISOString();
const point = (time: string, v: number | null): SeriesPoint => ({ time, values: { in_bps: v } });

describe("mapa cieplna – obliczenia (0.37.0)", () => {
  const points = [point(at(28, 20), 10), point(at(28, 20, 30), 30), point(at(29, 20), 50), point(at(29, 3), null)];

  it("dni tygodnia: średnia albo maksimum z próbek tej godziny", () => {
    const avg = heatmapGrid(points, "in_bps", "weekday", "avg", 7);
    expect(avg.rows.map((r) => r.key)).toEqual(["0", "1", "2", "3", "4", "5", "6"]);
    expect(avg.rows[2].cells[20]).toBe(20); // środa 20:00 – średnia z 10 i 30
    expect(avg.rows[3].cells[20]).toBe(50);
    expect(avg.rows[3].cells[3]).toBeNull(); // pusta próbka nie liczy się jako zero
    expect([avg.min, avg.max]).toEqual([20, 50]);
    expect(heatmapGrid(points, "in_bps", "weekday", "max", 7).rows[2].cells[20]).toBe(30);
  });

  it("dzień po dniu: wszystkie dni okresu, także bez danych", () => {
    const grid = heatmapGrid(points, "in_bps", "date", "avg", 7, new Date(2026, 9, 29, 22));
    expect(grid.rows.map((r) => r.key)).toEqual(["2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29"]);
    expect(grid.rows[0].cells.every((c) => c === null)).toBe(true);
    expect(grid.rows[5].cells[20]).toBe(20);
  });

  it("natężenie koloru i dzień tygodnia od poniedziałku", () => {
    expect([intensity(20, 20, 50), intensity(50, 20, 50), intensity(35, 20, 50), intensity(null, 20, 50), intensity(7, 7, 7)]).toEqual([0, 1, 0.5, 0, 1]);
    expect(weekday(new Date(2026, 10, 2))).toBe(0); // poniedziałek
    expect(weekday(new Date(2026, 10, 8))).toBe(6); // niedziela
  });
});

describe("mapa cieplna na pulpicie", () => {
  it("kratki godzina × dzień tygodnia z kolejnych tygodni", async () => {
    const heat = newWidget("heatmap", "h1");
    const layout: DashboardLayout = { version: 1, widgets: [heat] };
    const { calls } = mockApi({ layout });
    renderApp();
    const grid = await screen.findByRole("grid", { name: "Ruch WAN: Pobieranie" });
    expect(within(grid).getAllByRole("rowheader")).toHaveLength(7);
    expect(within(grid).getAllByRole("gridcell")).toHaveLength(7 * 24);
    // 4 tygodnie = 4 zapytania o 7 dni, każde o tydzień wcześniej
    for (const offset of ["", "&offset=10080", "&offset=20160", "&offset=30240"]) {
      expect(calls.some((c) => c.path === `/api/dashboard/traffic?minutes=10080${offset}`)).toBe(true);
    }
    expect(screen.getByText(/Średnio: pobieranie z 4 tyg\./)).toBeInTheDocument();
  });
});
