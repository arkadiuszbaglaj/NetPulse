import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { appendPoint, LIVE_MAX_POINTS, liveUrl, loadPercent } from "../lib/live";
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

  it("liczy obciążenie z większego kierunku względem prędkości łącza", () => {
    expect(loadPercent({ in_bps: 250_000_000, out_bps: 10_000_000 }, 1000)).toBe(25);
    expect(loadPercent({ in_bps: 5_000_000_000, out_bps: null }, 1000)).toBe(100);
    expect(loadPercent({ in_bps: 1, out_bps: 1 }, null)).toBeNull();
    expect(loadPercent({ in_bps: null, out_bps: null }, 1000)).toBeNull();
  });

  it("pokazuje każdy port WAN osobno z obciążeniem łącza", async () => {
    mockApi();
    renderApp();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Na żywo" }));
    const ws = FakeSocket.instances[0];
    const ports = [
      { id: 8, device_id: 1, name: "WAN 1", speed_mbps: 1000, in_bps: 250_000_000, out_bps: 20_000_000 },
      { id: 9, device_id: 1, name: "WAN 2", speed_mbps: 100, in_bps: 0, out_bps: 0 },
    ];
    act(() => ws.onmessage?.({ data: JSON.stringify({ time: "2026-10-25T10:00:00Z", in_bps: 250_000_000, out_bps: 20_000_000, ports }) }));
    const list = await screen.findByRole("list", { name: "Porty WAN na żywo" });
    expect(list).toHaveTextContent("WAN 1");
    expect(list).toHaveTextContent("WAN 2");
    expect(screen.getByRole("meter", { name: "Obciążenie 25% z 1 Gb/s" })).toHaveAttribute("aria-valuenow", "25");
    expect(screen.getByRole("meter", { name: "Obciążenie 0% z 100 Mb/s" })).toBeInTheDocument();
  });

  it("tabela portów urządzenia na żywo: prędkość i obciążenie każdego portu", async () => {
    mockApi();
    renderApp("/devices/1");
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: /Porty/ });
    expect(FakeSocket.instances).toHaveLength(0);
    await user.click(screen.getAllByRole("button", { name: "Na żywo" }).at(-1)!);
    const ws = FakeSocket.instances.at(-1)!;
    expect(ws.url).toMatch(/\/api\/live\/ports\?device=1$/);

    act(() => ws.onmessage?.({ data: JSON.stringify({ time: "2026-10-25T10:00:00Z", ports: [{ id: 11, in_bps: 500_000_000, out_bps: 3_000_000 }, { id: 12, in_bps: null, out_bps: null }] }) }));
    expect(await screen.findByText("500 Mb/s")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Obciążenie" })).toBeInTheDocument();
    expect(screen.getByRole("meter", { name: "Obciążenie 50% z 1 Gb/s" })).toBeInTheDocument();

    act(() => ws.onclose?.());
    expect(await screen.findByText(/tabela wróciła do zwykłego odświeżania/)).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Obciążenie" })).not.toBeInTheDocument();
  });

  it("wykres ruchu na stronie portu przechodzi na żywo", async () => {
    mockApi();
    renderApp("/devices/1/ports/11");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Na żywo" }));
    const ws = FakeSocket.instances[0];
    expect(ws.url).toMatch(/\/api\/live\/ports\?device=1$/);
    act(() => ws.onmessage?.({ data: JSON.stringify({ time: "2026-10-25T10:00:00Z", ports: [{ id: 11, in_bps: 7_500_000, out_bps: 1_000 }, { id: 12, in_bps: 99, out_bps: 99 }] }) }));
    expect(await screen.findByText(/Pobieranie: 7,5 Mb\/s/)).toBeInTheDocument();
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
