import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { newWidget, type DashboardLayout, type Widget } from "../lib/layout";
import type { CollectionRow } from "../lib/panels";
import type { WanLink } from "../lib/wan";
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

beforeEach(() => {
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
});

const layoutWith = (...widgets: Widget[]): DashboardLayout => ({ version: 1, widgets });
const WAN: WanLink = {
  id: 1, name: "WAN 1", position: 1, device_id: 1, device_name: "UCG Ultra", interface_id: 8, interface_name: "eth4", interface_label: "WAN",
  speed_mbps: 1000, state: "active", state_since: null, source: "controller", in_bps: null, out_bps: null, sampled_at: null,
}; // prettier-ignore
const PORTS: CollectionRow[] = [11, 12].map((id) => ({ key: String(id), label: `Port ${id - 10}`, device_id: 1, values: { up: 1, in_bps: 1e6, out_bps: 1e5, speed_mbps: 1000 } }));
const sample = (data: object) => ({ data: JSON.stringify({ time: "t", ports: [], ...data }) });

describe("dane na żywo na pulpicie (0.45.0)", () => {
  it("kafelki WAN i tabela portów biorą bieżące wartości z jednego połączenia na urządzenie", async () => {
    const table = { ...newWidget("table", "t1"), config: { title: "Porty bramy", collection: { kind: "ports" as const, device_id: 1 }, columns: ["up", "in_bps"], sort_by: null, sort_desc: false, limit: 20, unit: "bits" as const } };
    const api = mockApi({ layout: layoutWith({ id: "s", type: "summary", w: 12, config: { tiles: ["wan_down", "wan_up"] } }, table as Widget), collections: { ports: PORTS } });
    api.state.wanStatus = { links: [WAN], active_ids: [1] };
    renderApp();
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(1)); // brama: WAN i tabela dzielą połączenie
    expect(FakeSocket.instances[0].url).toMatch(/\/api\/live\/device\?device=1$/);
    act(() => FakeSocket.instances[0].onmessage?.(sample({ ports: [{ id: 8, in_bps: 250e6, out_bps: 12e6 }, { id: 11, in_bps: 77e6, out_bps: 0, up: 1 }] })));
    expect(await screen.findByText("250 Mb/s")).toBeInTheDocument();
    expect(screen.getByText("12 Mb/s")).toBeInTheDocument();
    const ports = screen.getByRole("table", { name: "Porty bramy" });
    expect(within(ports).getByText("77 Mb/s")).toBeInTheDocument();
    expect(screen.getAllByText("Na żywo").length).toBeGreaterThanOrEqual(3); // przełącznik + kafelki + tabela
  });

  it("przełącznik w pasku górnym wstrzymuje dane na żywo i zapamiętuje wybór", async () => {
    const api = mockApi({ layout: layoutWith({ id: "s", type: "summary", w: 12, config: { tiles: ["wan_down"] } }) });
    api.state.wanStatus = { links: [WAN], active_ids: [1] };
    renderApp();
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Na żywo/ }));
    expect(screen.getByRole("button", { name: /Wstrzymane/ })).toHaveAttribute("aria-pressed", "false");
    expect(localStorage.getItem("netpulse.live")).toBe("off");
    await waitFor(() => expect(FakeSocket.instances[0].closed).toBe(true), { timeout: 4000 });
  });
});
