import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

// jsdom nie ma ResizeObserver (siatka pulpitu mierzy nim szerokość; w testach zostaje szerokość początkowa 1280 px)
if (!("ResizeObserver" in window)) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(window, "ResizeObserver", { writable: true, value: ResizeObserverStub });
}

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

// jsdom nie ma canvasu, a wykresy ECharts go wymagają – w testach zastępuje je prosty stub:
// nazwy widocznych serii, osie i liczba punktów
vi.mock("../components/charts/PanelChart", () => ({
  default: ({ lines, ariaLabel, right }: { lines: { name: string; rows: unknown[] }[]; ariaLabel: string; right: unknown }) => (
    <div role="img" aria-label={ariaLabel} data-testid="chart" data-points={lines[0]?.rows.length ?? 0} data-right-axis={right ? "yes" : "no"}>
      {lines.map((l) => l.name).join(", ")}
    </div>
  ),
}));

