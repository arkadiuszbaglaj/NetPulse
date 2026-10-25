import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

// jsdom nie ma matchMedia
if (!window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

// Wykres panelu: nazwy widocznych serii, osie i liczba punktów
vi.mock("../components/charts/PanelChart", () => ({
  default: ({ lines, ariaLabel, right }: { lines: { name: string; rows: unknown[] }[]; ariaLabel: string; right: unknown }) => (
    <div role="img" aria-label={ariaLabel} data-testid="chart" data-points={lines[0]?.rows.length ?? 0} data-right-axis={right ? "yes" : "no"}>
      {lines.map((l) => l.name).join(", ")}
    </div>
  ),
}));

// jsdom nie ma też canvasu, a wykresy ECharts go wymagają – w testach zastępuje je prosty stub
vi.mock("../components/charts/TimeSeriesChart", () => ({
  default: ({ series, points, ariaLabel }: { series: { name: string }[]; points: unknown[]; ariaLabel: string }) => (
    <div role="img" aria-label={ariaLabel} data-testid="chart" data-points={points.length}>
      {series.map((s) => s.name).join(", ")}
    </div>
  ),
}));
