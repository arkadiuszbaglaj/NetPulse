import { screen, within } from "@testing-library/react";
import { NODE_H, NODE_W, groupByPort, isInternetNode, layoutTopology, pickRoot, type Topology, type TopologyNode } from "../lib/topology";
import type { NetworkClient } from "../lib/unifi";
import { mockApi } from "../test/mockApi";
import { renderApp } from "../test/renderApp";

const node = (id: string, name: string, device_kind: string | null, kind: "device" | "external" = "device"): TopologyNode => ({
  id,
  kind,
  device_id: kind === "device" ? Number(id.slice(1)) : null,
  name,
  device_kind,
  model: null,
  status: "up",
});

// Brama (d1) – switch (d2) – AP (d3); modem (xaa) za bramą
const TOPO: Topology = {
  nodes: [node("d1", "UCG", "gateway"), node("d2", "USW", "switch"), node("d3", "U6+", "ap"), node("xaa", "02:00:ff:33:66:69", null, "external")],
  edges: [
    { a: "d1", a_port: 1, b: "d2", b_port: 8 },
    { a: "d2", a_port: 1, b: "d3", b_port: 1 },
    { a: "d1", a_port: 5, b: "xaa", b_port: null },
  ],
};

const CLIENT: NetworkClient = {
  mac: "02:00:ca:62:d5:01",
  name: "Telewizor",
  ip: "192.168.1.50",
  is_wired: true,
  is_guest: false,
  essid: null,
  radio: null,
  signal_dbm: null,
  tx_rate_kbps: null,
  rx_rate_kbps: null,
  uplink_device_id: 2,
  uplink_name: "USW",
  uplink_port: 7,
  connected_s: 1000,
  updated_at: "2026-10-25T10:00:00Z",
};

describe("układ mapy sieci", () => {
  it("wybiera bramę jako korzeń", () => {
    expect(pickRoot(TOPO.nodes)?.id).toBe("d1");
    expect(pickRoot([node("d2", "USW", "switch")])?.id).toBe("d2");
    expect(pickRoot([])).toBeUndefined();
  });

  it("układa warstwy: modem nad bramą, potem switch, potem AP", () => {
    const { places } = layoutTopology(TOPO.nodes, TOPO.edges);
    expect(places.xaa.y).toBeLessThan(places.d1.y);
    expect(places.d1.y).toBeLessThan(places.d2.y);
    expect(places.d2.y).toBeLessThan(places.d3.y);
    expect(places.d2.y - places.d1.y).toBeGreaterThan(NODE_H);
  });

  it("nie nakłada węzłów jednej warstwy i mieści je w szerokości", () => {
    const nodes = [node("d1", "UCG", "gateway"), node("d2", "A", "switch"), node("d3", "B", "switch"), node("d4", "C", "ap")];
    const edges = [
      { a: "d1", a_port: 1, b: "d2", b_port: 1 },
      { a: "d1", a_port: 2, b: "d3", b_port: 1 },
      { a: "d3", a_port: 2, b: "d4", b_port: 1 },
    ];
    const { places, width } = layoutTopology(nodes, edges);
    const row = [places.d2, places.d3].sort((p, q) => p.x - q.x);
    expect(row[1].x - row[0].x).toBeGreaterThanOrEqual(NODE_W);
    for (const p of Object.values(places)) expect(p.x + NODE_W).toBeLessThanOrEqual(width);
    expect(places.d4.x).toBeGreaterThanOrEqual(0);
  });

  it("urządzenia bez połączenia z bramą trafiają do ostatniej warstwy", () => {
    const { places } = layoutTopology([node("d1", "UCG", "gateway"), node("d9", "Osobno", "switch")], []);
    expect(places.d9.y).toBeGreaterThan(places.d1.y);
  });

  it("pusta mapa daje pusty układ", () => {
    expect(layoutTopology([], [])).toEqual({ places: {}, width: 0, height: 0 });
  });
});

describe("strona Mapa sieci", () => {
  it("pokazuje węzły, porty kabli i klientów przy portach", async () => {
    mockApi({ topology: TOPO, clients: [CLIENT] });
    renderApp("/topology");
    expect(await screen.findByRole("heading", { name: "USW" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "UCG" })).toBeInTheDocument();
    // Nazwa węzła prowadzi do strony urządzenia
    const ucg = TOPO.nodes.find((n) => n.name === "UCG")!;
    expect(screen.getByRole("link", { name: "UCG" })).toHaveAttribute("href", `/devices/${ucg.device_id}`);
    expect(screen.getByText("Internet (WAN)")).toBeInTheDocument(); // sąsiad bramy za jej portem WAN
    expect(screen.queryByText("Nieznane urządzenie")).not.toBeInTheDocument();
    expect(screen.queryByText("02:00:ff:33:66:69")).not.toBeInTheDocument(); // bez adresu MAC modemu
    expect(await screen.findByText("port 7: Telewizor")).toBeInTheDocument();

    const links = screen.getByRole("region", { name: "Połączenia" });
    expect(within(links).getByText("UCG (port 1) ↔ USW (port 8)")).toBeInTheDocument();
    expect(within(links).getByText("USW (port 1) ↔ U6+ (port 1)")).toBeInTheDocument();
  });

  it("wyjaśnia, jak uzyskać mapę, gdy nie ma danych", async () => {
    mockApi();
    renderApp("/topology");
    expect(await screen.findByText("Brak danych o połączeniach")).toBeInTheDocument();
  });

  it("pokazuje błąd, gdy API nie odpowiada", async () => {
    mockApi({ overrides: { "GET /api/topology": { status: 500, body: { detail: "awaria" } } } });
    renderApp("/topology");
    expect(await screen.findByText("Nie udało się pobrać mapy sieci.")).toBeInTheDocument();
  });

  it("menu zawiera pozycję Mapa sieci", async () => {
    mockApi();
    renderApp("/topology");
    expect((await screen.findAllByRole("link", { name: "Mapa sieci" })).length).toBeGreaterThan(0);
  });
});

describe("Internet i grupowanie klientów na porcie", () => {
  it("węzeł zewnętrzny za bramą to Internet, za switchem to nieznane urządzenie", () => {
    const xsw = node("xbb", "02:00:aa:aa:aa:aa", null, "external");
    const edges = [...TOPO.edges, { a: "d2", a_port: 3, b: "xbb", b_port: null }];
    const nodes = [...TOPO.nodes, xsw];
    expect(isInternetNode(nodes.find((n) => n.id === "xaa")!, nodes, edges)).toBe(true);
    expect(isInternetNode(xsw, nodes, edges)).toBe(false);
    expect(isInternetNode(nodes[0], nodes, edges)).toBe(false); // urządzenie NetPulse nigdy
    expect(isInternetNode(node("xzz", "02:00:00:00:00:01", null, "external"), nodes, edges)).toBe(false); // bez kabla
  });

  it("grupuje klientów po porcie, porty rosnąco", () => {
    const groups = groupByPort([{ uplink_port: 7 }, { uplink_port: 3 }, { uplink_port: 3 }, { uplink_port: null }]);
    expect(groups.map((g) => [g.port, g.items.length])).toEqual([
      [3, 2],
      [7, 1],
      [null, 1],
    ]);
  });

  it("karta zwija kilku klientów na jednym porcie w jedną linię z odmianą", async () => {
    const on = (mac: string, name: string, port: number): NetworkClient => ({ ...CLIENT, mac, name, uplink_port: port, uplink_device_id: 1 });
    mockApi({
      topology: TOPO,
      clients: [
        on("02:00:00:00:00:01", "PC", 3),
        on("02:00:00:00:00:02", "VM", 3),
        on("02:00:00:00:00:03", "netpulse", 3),
        ...[1, 2, 3, 4, 5].map((i) => on(`02:00:00:00:01:0${i}`, `x${i}`, 4)),
        on("02:00:00:00:02:01", "Drukarka", 2),
      ],
    });
    renderApp("/topology");
    expect(await screen.findByText("port 3: 3 urządzenia")).toBeInTheDocument();
    expect(screen.getByText("port 4: 5 urządzeń")).toBeInTheDocument();
    expect(screen.getByText("port 2: Drukarka")).toBeInTheDocument();
    expect(screen.getByText("port 3: 3 urządzenia")).toHaveAttribute("title", "PC, VM, netpulse");
  });

  it("w mapie widać podpis Internet (WAN)", async () => {
    mockApi({ topology: TOPO });
    renderApp("/topology");
    expect(await screen.findByText("Internet (WAN)")).toBeInTheDocument();
  });
});
