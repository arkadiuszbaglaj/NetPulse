import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { upgradeChartConfig } from "../../lib/layout";
import { RefreshProvider } from "../../lib/refresh";
import { useChartQueries } from "./chartSource";

describe("useChartQueries", () => {
  it("zwraca te same `queries` przy ponownym renderze bez nowych danych (wykres się nie przerysowuje)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ minutes: 60, bucket_s: 30, points: [] }), { status: 200 })),
    );
    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <RefreshProvider fixed={{ refreshSeconds: 0, rangeMinutes: 60 }}>{children}</RefreshProvider>
      </QueryClientProvider>
    );
    const config = upgradeChartConfig({ source: { kind: "wan" } } as Parameters<typeof upgradeChartConfig>[0]);
    const { result, rerender } = renderHook(() => useChartQueries(config), { wrapper });
    await waitFor(() => expect(result.current.queries[0].data).toBeDefined());
    const before = result.current.queries;
    rerender();
    rerender();
    expect(result.current.queries).toBe(before);
    vi.unstubAllGlobals();
  });
});
