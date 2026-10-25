import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { formatBytes, metricFormatter } from "../lib/format";
import { newWidget, SOURCE_METRICS, toggleMetric, unitClassOf } from "../lib/layout";
import { usageTone, type SystemInfo } from "../lib/system";
import { mockApi } from "../test/mockApi";
import { renderApp } from "../test/renderApp";

const SYSTEM: SystemInfo = {
  sampled_at: "2026-10-25T10:00:00Z",
  cpu_percent: 23.4,
  load1: 0.52,
  load5: 0.4,
  load15: 0.31,
  mem_used_percent: 61.2,
  mem_total_bytes: 16_000_000_000,
  swap_used_percent: null,
  disk_used_percent: 92,
  disk_free_bytes: 40_000_000_000,
  disk_total_bytes: 500_000_000_000,
  uptime_s: 90_000,
  temp_c: 54.3,
  db_size_bytes: 250_000_000,
  poll_interval_s: 30,
};

describe("formatowanie stanu serwera", () => {
  it("formatuje rozmiary i temperaturę", () => {
    expect(formatBytes(250_000_000)).toBe("250 MB");
    expect(formatBytes(1_500_000_000)).toBe("1,5 GB");
    expect(formatBytes(null)).toBe("–");
    expect(metricFormatter("temp", "bits")(54.34)).toBe("54,3 °C");
    expect(metricFormatter("size", "bits")(2_000_000_000)).toBe("2 GB");
  });

  it("zajętość: ostrzeżenie od 85%, błąd od 95%", () => {
    expect(usageTone(null)).toBe("ok");
    expect(usageTone(50)).toBe("ok");
    expect(usageTone(85)).toBe("warn");
    expect(usageTone(95)).toBe("danger");
  });

  it("metryki serwera mają jednostki, a procenty łączą się w jednym wykresie", () => {
    expect(SOURCE_METRICS.server).toContain("disk_used_percent");
    expect(unitClassOf("temp_c")).toBe("temp");
    expect(unitClassOf("db_size_bytes")).toBe("size");
    const series = toggleMetric([{ key: "cpu_percent", color: 1 }], "disk_used_percent", true);
    expect(series.map((s) => s.key)).toEqual(["cpu_percent", "disk_used_percent"]);
    expect(toggleMetric(series, "temp_c", true).map((s) => s.key)).toEqual(["temp_c"]); // inna jednostka
  });
});

describe("widget Serwer", () => {
  it("pokazuje CPU, RAM, dysk, bazę i czas pracy", async () => {
    mockApi({ system: SYSTEM, layout: { version: 1, widgets: [newWidget("server", "srv")] } });
    renderApp();
    expect(await screen.findByRole("meter", { name: "CPU" })).toHaveAttribute("aria-valuenow", "23");
    expect(screen.getByRole("meter", { name: "RAM" })).toHaveAttribute("aria-valuenow", "61");
    expect(screen.getByRole("meter", { name: "Dysk" })).toHaveAttribute("aria-valuenow", "92");
    expect(screen.queryByRole("meter", { name: "Swap" })).not.toBeInTheDocument(); // brak swapu
    expect(screen.getByText("wolne 40 GB z 500 GB")).toBeInTheDocument();
    expect(screen.getByText("250 MB")).toBeInTheDocument();
    expect(screen.getByText("54,3 °C")).toBeInTheDocument();
    expect(screen.getByText("0,52 / 0,40 / 0,31")).toBeInTheDocument();
  });

  it("wyjaśnia brak próbek", async () => {
    mockApi({ layout: { version: 1, widgets: [newWidget("server", "srv")] } });
    renderApp();
    expect(await screen.findByText(/Brak próbek stanu serwera/)).toBeInTheDocument();
  });

  it("pokazuje błąd, gdy API nie odpowiada", async () => {
    mockApi({ overrides: { "GET /api/system": { status: 500, body: { detail: "awaria" } } }, layout: { version: 1, widgets: [newWidget("server", "srv")] } });
    renderApp();
    expect(await screen.findByText("Nie udało się pobrać stanu serwera.")).toBeInTheDocument();
  });

  it("można go dodać do pulpitu z listy widgetów", async () => {
    const { state } = mockApi({ layout: { version: 1, widgets: [] } });
    renderApp();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edytuj pulpit" }));
    await user.click(screen.getByRole("button", { name: "Dodaj widget" }));
    const picker = await screen.findByRole("dialog", { name: "Dodaj widget" });
    await user.click(within(picker).getByRole("button", { name: /Serwer/ }));
    const info = await screen.findByRole("dialog", { name: "Serwer" });
    await user.click(within(info).getByRole("button", { name: "Dodaj widget" }));
    await user.click(screen.getByRole("button", { name: "Zapisz" }));
    await waitFor(() => expect(state.layout?.widgets.map((w) => w.type)).toEqual(["server"]));
  });
});
