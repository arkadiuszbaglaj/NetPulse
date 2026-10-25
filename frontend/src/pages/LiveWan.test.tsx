import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { appendPoint, LIVE_MAX_POINTS, liveUrl } from "../lib/live";
import { mockApi } from "../test/mockApi";
import { renderApp } from "../test/renderApp";

class FakeSocket {
  static instances: FakeSocket[] = [];
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  close() {
    this.closed = true;
  }
}

describe("tryb Na żywo", () => {
  beforeEach(() => {
    FakeSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeSocket);
  });

  it("buduje adres WebSocketu z adresu strony", () => {
    expect(liveUrl({ protocol: "http:", host: "serwer:8000" })).toBe("ws://serwer:8000/api/live/wan");
    expect(liveUrl({ protocol: "https:", host: "np.lan" })).toBe("wss://np.lan/api/live/wan");
  });

  it("trzyma ograniczoną liczbę ostatnich próbek", () => {
    let points: ReturnType<typeof appendPoint> = [];
    for (let i = 0; i < LIVE_MAX_POINTS + 10; i++) points = appendPoint(points, { time: String(i), in_bps: i, out_bps: null });
    expect(points).toHaveLength(LIVE_MAX_POINTS);
    expect(points[0].time).toBe("10");
  });

  it("pokazuje bieżące wartości z WebSocketu i wraca do zwykłego odświeżania po zerwaniu", async () => {
    mockApi();
    renderApp();
    const user = userEvent.setup();
    const toggle = await screen.findByRole("button", { name: "Na żywo" });
    expect(FakeSocket.instances).toHaveLength(0); // bez włączenia nic się nie łączy

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    const ws = FakeSocket.instances[0];
    expect(ws.url).toMatch(/\/api\/live\/wan$/);

    act(() => ws.onmessage?.({ data: JSON.stringify({ time: "2026-10-25T10:00:00Z", in_bps: 7_500_000, out_bps: 1_200_000 }) }));
    expect(await screen.findByText(/Pobieranie: 7,5 Mb\/s/)).toBeInTheDocument();

    act(() => ws.onclose?.());
    expect(await screen.findByText(/Połączenie „Na żywo” zostało przerwane/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Na żywo" })).toHaveAttribute("aria-pressed", "false");
    expect(ws.closed).toBe(true);
  });

  it("wyłączenie przełącznika zamyka połączenie", async () => {
    mockApi();
    renderApp();
    const user = userEvent.setup();
    const toggle = await screen.findByRole("button", { name: "Na żywo" });
    await user.click(toggle);
    await user.click(toggle);
    expect(FakeSocket.instances[0].closed).toBe(true);
  });
});
