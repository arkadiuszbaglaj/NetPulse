import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { newWidget, type DashboardLayout, type PieConfig, type Widget } from "../lib/layout";
import type { CollectionRow } from "../lib/panels";
import { pieCollection, pieData, pieMetricsFor } from "../lib/pie";
import { mockApi } from "../test/mockApi";
import { renderApp } from "../test/renderApp";

const layoutWith = (...widgets: Widget[]): DashboardLayout => ({ version: 1, widgets });
const pie = (config: Partial<PieConfig>): PieConfig => ({ title: null, device_id: null, metric: "devices_state", item: null, limit: 8, ...config });

const DEVICES: CollectionRow[] = [
  { key: "1", label: "UCG Ultra", device_id: 1, values: { up: 1, cpu_percent: 23, mem_used_percent: 75 } },
  { key: "2", label: "USW Lite", device_id: 2, values: { up: 0, cpu_percent: null, mem_used_percent: null } },
  { key: "3", label: "U6+", device_id: 3, values: { up: null, cpu_percent: 5, mem_used_percent: 40 } },
];
const PORTS: CollectionRow[] = [1, 2, 3, 4].map((n) => ({
  key: String(10 + n),
  label: `Port ${n}`,
  device_id: 1,
  values: { up: n < 4 ? 1 : 0, in_bps: n < 4 ? n * 10e6 : null, out_bps: 1e6 },
}));
const DISKS: CollectionRow[] = [
  { key: "/", label: "/", device_id: 5, values: { used_percent: 35, used_bytes: 35e9, free_bytes: 65e9, total_bytes: 100e9 } },
  { key: "/srv", label: "/srv", device_id: 5, values: { used_percent: 92, used_bytes: 920e9, free_bytes: 80e9, total_bytes: 1000e9 } },
];

describe("wykres kołowy – dane", () => {
  it("co można monitorować zależy od urządzenia", () => {
    expect(pieMetricsFor(null)).toEqual(["devices_state", "checks_state", "wifi_clients"]);
    expect(pieMetricsFor({ driver: "auto", kind: "switch" })).toEqual(["cpu", "mem", "ports_in", "ports_out", "ports_state"]);
    expect(pieMetricsFor({ driver: "auto", kind: "ap" })).toContain("wifi_clients");
    expect(pieMetricsFor({ driver: "agent", kind: "server" })).toEqual(["cpu", "mem", "disk", "disks_share", "containers_mem", "containers_cpu", "services_state"]);
    expect(pieMetricsFor({ driver: "proxmox", kind: "server" })).toEqual(["cpu", "mem", "guests_mem", "guests_state"]);
  });

  it("kolekcja: CPU z listy urządzeń, porty – wybranego urządzenia", () => {
    expect(pieCollection(pie({ device_id: 1, metric: "cpu" }))).toEqual({ kind: "devices", device_id: null });
    expect(pieCollection(pie({ device_id: 2, metric: "ports_in" }))).toEqual({ kind: "ports", device_id: 2 });
    expect(pieCollection(pie({ metric: "checks_state" }))).toEqual({ kind: "checks", device_id: null });
  });

  it("zajętość: CPU urządzenia i wybrany dysk", () => {
    const cpu = pieData(pie({ device_id: 1, metric: "cpu" }), DEVICES)!;
    expect(cpu.center).toBe("23%");
    expect(cpu.slices.map((s) => [s.label, s.value])).toEqual([
      ["Zajęte", 23],
      ["Wolne", 77],
    ]);
    expect(pieData(pie({ device_id: 2, metric: "cpu" }), DEVICES)).toBeNull(); // brak odczytu
    const disk = pieData(pie({ device_id: 5, metric: "disk", item: "/srv" }), DISKS)!;
    expect([disk.center, disk.sub, disk.slices[0].color]).toEqual(["92%", "/srv", "var(--chart-5)"]);
    expect(pieData(pie({ device_id: 5, metric: "disk" }), DISKS)!.sub).toBe("/"); // bez wyboru – pierwszy dysk
  });

  it("udział: od największego, reszta jako „Pozostałe”, zera pominięte", () => {
    const data = pieData(pie({ device_id: 1, metric: "ports_in", limit: 2 }), PORTS)!;
    expect(data.slices.map((s) => s.label)).toEqual(["Port 3", "Pozostałe"]);
    expect(data.slices[1].value).toBe(30e6);
    expect(data.center).toBe("60 Mb/s");
  });

  it("stan: działa, nie działa i brak danych", () => {
    const data = pieData(pie({ metric: "devices_state" }), DEVICES)!;
    expect(data.center).toBe("1 z 3");
    expect(data.slices.map((s) => [s.key, s.value])).toEqual([
      ["up", 1],
      ["down", 1],
      ["unknown", 1],
    ]);
    expect(pieData(pie({ metric: "checks_state" }), [])).toBeNull();
  });
});

describe("wykres kołowy – pulpit", () => {
  it("pokazuje pierścień z liczbą w środku i legendą", async () => {
    const w = newWidget("pie", "p1");
    if (w.type !== "pie") throw new Error();
    w.config = pie({ device_id: 1, metric: "ports_state" });
    mockApi({ layout: layoutWith(w), collections: { ports: PORTS } });
    renderApp();
    expect(await screen.findByRole("img", { name: /Porty: podłączone i odłączone.*Działa 3, Nie działa 1/ })).toBeInTheDocument();
    expect(screen.getByText("3 z 4")).toBeInTheDocument();
    const legend = screen.getByRole("list", { name: "Legenda wykresu" });
    expect(within(legend).getByText("75%")).toBeInTheDocument();
  });

  it("edytor: urządzenie, potem co monitorować; zapis do układu", async () => {
    const { state } = mockApi({ layout: layoutWith(), collections: { devices: DEVICES, ports: PORTS } });
    renderApp();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edytuj pulpit" }));
    await user.click(screen.getByRole("button", { name: "Dodaj widget" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Dodaj widget" })).getByRole("button", { name: /Wykres kołowy/ }));
    const form = await screen.findByRole("dialog", { name: "Nowy wykres kołowy" });

    // Bez urządzenia – cała sieć
    const metric = within(form).getByLabelText("Co monitorować");
    expect(within(metric).getAllByRole("option").map((o) => o.textContent)).toContain("Urządzenia: działają i nie");
    await user.selectOptions(within(form).getByLabelText("Urządzenie"), "1");
    expect(within(metric).queryByRole("option", { name: "Urządzenia: działają i nie" })).not.toBeInTheDocument();
    await user.selectOptions(metric, "cpu");
    expect(await within(form).findByRole("img", { name: /Procesor \(CPU\) · UCG Ultra: Zajęte 23%, Wolne 77%/ })).toBeInTheDocument(); // podgląd
    await user.selectOptions(metric, "ports_in");
    expect(within(form).getByLabelText("Najwięcej kawałków")).toBeInTheDocument();

    await user.click(within(form).getByRole("button", { name: "Zapisz" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Nowy wykres kołowy" })).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Zapisz" }));
    await waitFor(() => expect(state.layout).not.toBeNull());
    const saved = (state.layout as DashboardLayout).widgets[0];
    expect(saved.type === "pie" && saved.config).toMatchObject({ device_id: 1, metric: "ports_in", limit: 8, item: null });
  });
});
