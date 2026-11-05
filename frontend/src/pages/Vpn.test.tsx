import { screen } from "@testing-library/react";
import { AUTO_HEIGHT, defaultSeries, SOURCE_METRICS, unitClassOf, type DashboardLayout } from "../lib/layout";
import { sourceModule } from "../lib/modules";
import type { VpnStatus } from "../lib/vpn";
import { mockApi } from "../test/mockApi";
import { renderApp } from "../test/renderApp";

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

const VPN: VpnStatus = {
  at: ago(0),
  stale: false,
  device_id: 1,
  servers: [{ id: "net-wg", name: "WG-Home", type: "WireGuard", enabled: true, port: 51820, subnet: "192.168.3.1/24" }],
  users: [
    {
      name: "iPhone",
      server: "WG-Home",
      tunnel_ip: "192.168.3.2",
      connected: true,
      since: ago(5),
      last_seen: ago(0),
      remote_ip: "203.0.113.7",
      down_bytes: 76_000_000,
      up_bytes: 12_000_000,
      down_bps: 1_200_000,
      up_bps: 800_000,
    },
    {
      name: "Laptop",
      server: "WG-Home",
      tunnel_ip: "192.168.3.3",
      connected: false,
      since: null,
      last_seen: ago(120),
      remote_ip: null,
      down_bytes: null,
      up_bytes: null,
      down_bps: null,
      up_bps: null,
    },
  ],
};

const layout = (show_offline = true): DashboardLayout => ({ version: 1, widgets: [{ id: "vpn1", type: "vpn", w: 4, config: { title: null, show_offline } }] });

describe("widget VPN", () => {
  it("pokazuje serwer, połączonych z ruchem i rozłączonych z czasem ostatniego połączenia", async () => {
    mockApi({ overrides: { "GET /api/vpn": { status: 200, body: VPN } }, layout: layout() });
    renderApp();
    expect(await screen.findByText("iPhone")).toBeInTheDocument();
    expect(screen.getByText("WG-Home · WireGuard · UDP 51820 · 192.168.3.1/24")).toBeInTheDocument();
    expect(screen.getByText("połączeni: 1 z 2")).toBeInTheDocument();
    expect(screen.getByText(/^połączony od/)).toBeInTheDocument();
    expect(screen.getByText("192.168.3.2 · z 203.0.113.7")).toBeInTheDocument();
    expect(screen.getByText("↓ 76 MB · ↑ 12 MB")).toBeInTheDocument();
    expect(screen.getByText("Laptop")).toBeInTheDocument();
    expect(screen.getByText(/^ostatnio połączony/)).toBeInTheDocument();
  });

  it("tylko połączeni, gdy rozłączeni są ukryci", async () => {
    mockApi({ overrides: { "GET /api/vpn": { status: 200, body: VPN } }, layout: layout(false) });
    renderApp();
    expect(await screen.findByText("iPhone")).toBeInTheDocument();
    expect(screen.queryByText("Laptop")).not.toBeInTheDocument();
  });

  it("wyjaśnia brak serwera VPN", async () => {
    mockApi({ overrides: { "GET /api/vpn": { status: 200, body: { at: null, stale: false, device_id: null, servers: [], users: [] } } }, layout: layout() });
    renderApp();
    expect(await screen.findByText(/Brak serwera VPN na bramie UniFi/)).toBeInTheDocument();
  });

  it("źródło wykresu „Klient VPN” należy do modułu UniFi i rysuje pobieranie i wysyłanie", () => {
    expect(SOURCE_METRICS.vpn).toEqual(["down_bps", "up_bps", "connected"]);
    expect(defaultSeries("vpn").map((s) => s.key)).toEqual(["down_bps", "up_bps"]);
    expect(unitClassOf("down_bps")).toBe("rate");
    expect(sourceModule("vpn")).toBe("unifi");
    expect(AUTO_HEIGHT.has("vpn")).toBe(true);
  });
});
