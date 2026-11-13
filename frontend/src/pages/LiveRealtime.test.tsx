import { act, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardLayout } from "../lib/layout";
import { parseVpn } from "../lib/liveHub";
import { withLiveEdges, type TopologyEdge } from "../lib/topology";
import { withLiveVpn, type VpnStatus } from "../lib/vpn";
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

const STATUS: VpnStatus = {
  at: "2026-11-13T10:00:00Z",
  stale: true,
  device_id: 1,
  servers: [{ id: "net-wg", name: "WG-Home", type: "WireGuard", enabled: true, port: 51820, subnet: "192.168.3.1/24" }],
  users: [
    { name: "iPhone", server: "WG-Home", tunnel_ip: "192.168.3.2", connected: true, since: "2026-11-13T09:00:00Z", last_seen: "2026-11-13T10:00:00Z", remote_ip: "203.0.113.7", down_bytes: 1e6, up_bytes: 1e5, down_bps: 9e6, up_bps: 1e5 },
    { name: "Laptop", server: "WG-Home", tunnel_ip: "192.168.3.3", connected: false, since: null, last_seen: "2026-11-12T10:00:00Z", remote_ip: null, down_bytes: null, up_bytes: null, down_bps: null, up_bps: null },
  ],
};

const liveUser = (name: string, down_bps: number) => ({ name, since: "2026-11-13T10:01:00Z", remote_ip: "198.51.100.4", tunnel_ip: "192.168.3.9", down_bps, up_bps: 1000, down_bytes: 5e6, up_bytes: 2e5 });

describe("VPN na żywo (0.72.0)", () => {
  it("parseVpn odrzuca uszkodzone wpisy i pola", () => {
    const v = parseVpn({ time: "t", ok: true, users: [{ name: "A", down_bps: 5, up_bps: "x" }, { down_bps: 1 }, null] });
    expect(v.ok).toBe(true);
    expect(v.users).toHaveLength(1);
    expect(v.users[0]).toMatchObject({ name: "A", down_bps: 5, up_bps: null, since: null });
    expect(parseVpn(null)).toEqual({ time: "", ok: false, users: [] });
  });

  it("withLiveVpn: połączenie z kontrolera, rozłączenie, nowy klient i bieżąca prędkość", () => {
    const live = { time: "2026-11-13T10:02:00Z", ok: true, users: [liveUser("Laptop", 2e6), liveUser("Tablet", 3e6)] };
    const out = withLiveVpn(STATUS, live);
    expect(out.stale).toBe(false);
    expect(out.at).toBe(live.time);
    const by = new Map(out.users.map((u) => [u.name, u]));
    expect(by.get("Laptop")).toMatchObject({ connected: true, down_bps: 2e6, server: "WG-Home", last_seen: live.time });
    expect(by.get("Tablet")).toMatchObject({ connected: true, server: null });
    expect(by.get("iPhone")).toMatchObject({ connected: false, down_bps: null, since: null, last_seen: live.time });
    expect(out.users.map((u) => u.connected)).toEqual([true, true, false]); // połączeni najpierw
    expect(withLiveVpn(STATUS, null)).toBe(STATUS);
  });

  it("widget VPN pokazuje prędkość z kanału na żywo", async () => {
    const layout: DashboardLayout = { version: 1, widgets: [{ id: "vpn1", type: "vpn", w: 4, config: { title: null, show_offline: true } }] };
    mockApi({ overrides: { "GET /api/vpn": { status: 200, body: STATUS } }, layout });
    renderApp();
    expect(await screen.findByText("iPhone")).toBeInTheDocument();
    await waitFor(() => expect(FakeSocket.instances.some((s) => s.url.endsWith("/api/live/vpn"))).toBe(true));
    const ws = FakeSocket.instances.find((s) => s.url.endsWith("/api/live/vpn"))!;
    act(() => ws.onmessage?.({ data: JSON.stringify({ time: new Date().toISOString(), ok: true, users: [liveUser("Laptop", 42e6)] }) }));
    expect(await screen.findByText(/42 Mb\/s/)).toBeInTheDocument();
    expect(screen.getByText("połączeni: 1 z 2")).toBeInTheDocument();
  });
});

describe("mapa sieci na żywo (0.72.0)", () => {
  const edges: TopologyEdge[] = [
    { a: "gw", a_port: 1, b: "sw", b_port: 8, device_id: 1, interface_id: 11, speed_mbps: 1000, traffic_bps: 1e6, utilization: 0.001 },
    { a: "sw", a_port: 2, b: "ap", b_port: null, device_id: 2, interface_id: 21, speed_mbps: 100, traffic_bps: 5e6, utilization: 0.05 },
    { a: "x", a_port: null, b: "y", b_port: null },
  ];

  it("podmienia ruch i wykorzystanie kabli z próbką, resztę zostawia", () => {
    const out = withLiveEdges(edges, (dev, iface) => (dev === 1 && iface === 11 ? { in_bps: 200e6, out_bps: 600e6 } : null));
    expect(out[0]).toMatchObject({ traffic_bps: 600e6, utilization: 0.6 });
    expect(out[1]).toBe(edges[1]);
    expect(out[2]).toBe(edges[2]);
  });

  it("bez próbek zwraca tę samą tablicę (bez przeliczania układu)", () => {
    expect(withLiveEdges(edges, () => null)).toBe(edges);
    expect(withLiveEdges(edges, () => ({ in_bps: null, out_bps: null }))).toBe(edges);
  });

  it("wykorzystanie nie przekracza 100 %", () => {
    expect(withLiveEdges(edges, (d) => (d === 2 ? { in_bps: 150e6, out_bps: 0 } : null))[1].utilization).toBe(1);
  });
});
