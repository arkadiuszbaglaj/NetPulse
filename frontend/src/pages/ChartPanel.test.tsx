import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { buildLines, csvTime, leftTop, lineStats, linesToCsv, seriesName, thresholdBands } from "../components/charts/panelData";
import { fileName } from "../lib/download";
import { eventsFor, type ChartEvent } from "../lib/events";
import { defaultTitle, sourcePath } from "../components/widgets/chartSource";
import { newChartConfig, upgradeChartConfig, type ChartConfig, type DashboardLayout } from "../lib/layout";
import { TRAFFIC, mockApi } from "../test/mockApi";
import { renderApp } from "../test/renderApp";

const layoutWith = (config: ChartConfig): DashboardLayout => ({ version: 1, widgets: [{ id: "c1", type: "chart", w: 12, config }] });

describe("zdarzenia na wykresie (0.34.0)", () => {
  const ev = (kind: ChartEvent["kind"], device_id: number | null, interface_id: number | null = null): ChartEvent => ({
    time: "2026-10-29T12:00:00Z",
    kind,
    severity: kind === "alert" ? "warning" : null,
    title: `${kind} ${device_id ?? "-"} ${interface_id ?? "-"}`,
    device_id,
    interface_id,
  });
  const all = [ev("restart", 2), ev("alert", 2, 15), ev("alert", 2, 16), ev("alert", 3), ev("wan_switch", 1), ev("alert", null)];
  const titles = (list: ChartEvent[]) => list.map((e) => e.title);

  it("auto: wykres ogólny – przełączenia WAN i alerty bez urządzenia", () => {
    expect(titles(eventsFor(all, newChartConfig({ kind: "wan" })))).toEqual(["wan_switch 1 -", "alert - -"]);
  });

  it("auto: wykres urządzenia – jego restarty i alerty (też portów), wykres portu – tylko ten port", () => {
    expect(titles(eventsFor(all, newChartConfig({ kind: "device", id: 2 })))).toEqual(["restart 2 -", "alert 2 15", "alert 2 16"]);
    expect(titles(eventsFor(all, newChartConfig({ kind: "interface", id: 15, device_id: 2 })))).toEqual(["restart 2 -", "alert 2 15"]);
  });

  it("wszystkie albo żadne", () => {
    const c = newChartConfig({ kind: "wan" });
    expect(eventsFor(all, { ...c, annotations: "all" })).toHaveLength(all.length);
    expect(eventsFor(all, { ...c, annotations: "off" })).toEqual([]);
  });
});

describe("eksport wykresu (0.33.0)", () => {
  it("CSV dla polskiego Excela: średnik, przecinek, jednostka w nagłówku, puste pola", () => {
    const t1 = new Date(2026, 9, 29, 12, 0, 30).getTime();
    const t2 = t1 + 30_000;
    const line = (id: string, name: string, rows: [number, number | null][]) => ({ id, name, color: 1 as const, axis: "left" as const, rows, dashed: false });
    const csv = linesToCsv([line("A.in_bps", "Pobieranie", [[t1, 1.5e6], [t2, null]]), line("B.cpu_percent", 'CPU; "rdzeń"', [[t2, 12.25]])], "czas");
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1).split("\r\n")).toEqual([
      'czas;Pobieranie [b/s];"CPU; ""rdzeń"" [%]"',
      "2026-10-29 12:00:30;1500000;",
      "2026-10-29 12:01:00;;12,25",
    ]);
    expect(csvTime(t1)).toBe("2026-10-29 12:00:30");
  });

  it("nazwa pliku z tytułu i chwili, bez polskich znaków", () => {
    expect(fileName("Ruch WAN – łącze główne", "png", new Date(2026, 9, 29, 9, 5))).toBe("ruch-wan-lacze-glowne-2026-10-29-0905.png");
    expect(fileName("???", "csv", new Date(2026, 0, 1, 0, 0))).toBe("wykres-2026-01-01-0000.csv");
  });

  it("menu wykresu: pełny ekran, CSV i PNG", async () => {
    mockApi({ layout: layoutWith(newChartConfig({ kind: "wan" })) });
    renderApp();
    await screen.findByTestId("chart");
    await userEvent.setup().click(screen.getByRole("button", { name: "Więcej działań" }));
    const menu = screen.getByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Pełny ekran", "Pobierz dane (CSV)", "Pobierz obraz (PNG)"]);
  });
});

describe("model wykresu w czasie (0.26.0)", () => {
  it("stara konfiguracja (jedno źródło, y_max) zamienia się na zapytania i oś", () => {
    const c = upgradeChartConfig({ source: { kind: "wan" }, series: [{ key: "in_bps" }], y_max: 1e9, chart: "line", unit: "bits", smooth: false, height: "md" });
    expect(c.queries).toEqual([{ id: "A", source: { kind: "wan" }, series: [{ key: "in_bps" }], offset_min: 0 }]);
    expect(c.axes?.left?.max).toBe(1e9);
    expect(upgradeChartConfig(c)).toBe(c);
  });

  it("ścieżka API z przesunięciem w czasie", () => {
    expect(sourcePath({ kind: "wan" }, 60, 1440)).toBe("/api/dashboard/traffic?minutes=60&offset=1440");
    expect(sourcePath({ kind: "device", id: 3 }, 60)).toBe("/api/devices/3/metrics?minutes=60");
  });

  it("nazwy serii: źródło przy kilku zapytaniach, dopisek przy porównaniu", () => {
    expect(seriesName({ kind: "wan" }, { key: "in_bps" }, 1440)).toBe("Pobieranie (dzień wcześniej)");
    expect(seriesName({ kind: "wan" }, { key: "in_bps", label: "Wczoraj" }, 1440)).toBe("Wczoraj");
    const cfg: ChartConfig = {
      ...newChartConfig({ kind: "wan" }, [{ key: "in_bps", color: 1 }]),
      queries: [
        { id: "A", source: { kind: "wan" }, series: [{ key: "in_bps", color: 1 }] },
        { id: "B", source: { kind: "device", id: 1 }, series: [{ key: "cpu_percent", color: 3, axis: "right" }] },
      ],
    };
    const lines = buildLines(cfg, new Map([["A", TRAFFIC]]), defaultTitle);
    expect(lines.map((l) => [l.id, l.name, l.axis, l.rows.length])).toEqual([
      ["A.in_bps", "Ruch WAN: Pobieranie", "left", 2],
      ["B.cpu_percent", "Urządzenie #1: CPU", "right", 0],
    ]);
  });

  it("szczyt lewej osi: przy stosie suma serii w jednej chwili", () => {
    const line = (id: string, rows: [number, number | null][], axis: "left" | "right" = "left") => ({ id, name: id, color: 1 as const, axis, rows, dashed: false });
    const lines = [line("a", [[1, 10], [2, 30]]), line("b", [[1, 25], [2, null]]), line("c", [[1, 500]], "right")];
    expect(leftTop(lines, false)).toBe(30);
    expect(leftTop(lines, true)).toBe(35);
  });

  it("statystyki legendy i pasy progów", () => {
    expect(lineStats([[1, 2], [2, null], [3, 6], [4, 4]])).toEqual({ last: 4, min: 2, max: 6, avg: 4 });
    expect(lineStats([[1, null]])).toEqual({ last: null, min: null, max: null, avg: null });
    expect(thresholdBands([{ value: 90, color: 5 }, { value: 70, color: 4 }], 120)).toEqual([
      { from: 70, to: 90, color: 4 },
      { from: 90, to: 120, color: 5 },
    ]);
  });
});

describe("wykres na pulpicie", () => {
  it("legenda-tabela z min/maks/średnią; klik ukrywa serię", async () => {
    const config: ChartConfig = { ...newChartConfig({ kind: "wan" }), legend: { mode: "table", placement: "bottom", values: ["max", "avg"] } };
    mockApi({ layout: layoutWith(config) });
    renderApp();
    const table = await screen.findByRole("table", { name: "Legenda wykresu" });
    const rows = within(table).getAllByRole("row");
    expect(within(rows[0]).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Seria", "Maks", "Średnia"]);
    expect(rows[1]).toHaveTextContent(/Pobieranie\s*2 Mb\/s\s*1,5 Mb\/s/);
    const user = userEvent.setup();
    await user.click(within(table).getByRole("button", { name: "Pobieranie" }));
    expect(within(table).getByRole("button", { name: "Pobieranie" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("chart")).toHaveTextContent(/^Wysyłanie$/);
  });

  it("dwa źródła i porównanie z wczoraj: oś prawa i trzy serie", async () => {
    const config: ChartConfig = {
      ...newChartConfig({ kind: "wan" }, [{ key: "in_bps", color: 1 }]),
      queries: [
        { id: "A", source: { kind: "wan" }, series: [{ key: "in_bps", color: 1 }], offset_min: 0 },
        { id: "B", source: { kind: "wan" }, series: [{ key: "in_bps", color: 5 }], offset_min: 1440 },
        { id: "C", source: { kind: "device", id: 1 }, series: [{ key: "cpu_percent", color: 3, axis: "right" }], offset_min: 0 },
      ],
    };
    const { calls } = mockApi({ layout: layoutWith(config) });
    renderApp();
    const chart = await screen.findByTestId("chart");
    await waitFor(() => expect(chart).toHaveTextContent("Ruch WAN: Pobieranie, Ruch WAN: Pobieranie (dzień wcześniej), Urządzenie #1: CPU"));
    expect(chart).toHaveAttribute("data-right-axis", "yes");
    expect(calls.some((c) => c.path === "/api/dashboard/traffic?minutes=60&offset=1440")).toBe(true);
  });
});

describe("edytor wykresu", () => {
  it("drugie źródło, porównanie z dniem wcześniej, próg i legenda trafiają do układu", async () => {
    const { state } = mockApi({ layout: layoutWith(newChartConfig({ kind: "wan" })) });
    renderApp();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edytuj pulpit" }));
    await user.click(screen.getByRole("button", { name: "Edytuj: Ruch WAN" }));
    const form = await screen.findByRole("dialog", { name: "Edycja wykresu" });

    await user.click(within(form).getByRole("button", { name: "Porównaj z dniem wcześniej" }));
    const b = within(form).getByRole("region", { name: "Zapytanie B" });
    expect(within(b).getByLabelText("Okres")).toHaveValue("1440");

    await user.click(within(form).getByRole("button", { name: "Dodaj źródło" }));
    const c = within(form).getByRole("region", { name: "Zapytanie C" });
    await user.selectOptions(within(c).getByLabelText("Źródło danych"), "server");
    // CPU w % przy ruchu w Mb/s: sam przechodzi na oś prawą
    expect(within(c).getAllByLabelText("Oś")[0]).toHaveValue("right");

    await user.click(within(form).getByRole("button", { name: "Dodaj próg" }));
    await user.type(within(form).getByLabelText("Próg 1"), "800");
    await user.selectOptions(within(form).getByLabelText("Legenda"), "table");
    await user.click(within(form).getByLabelText("Maks"));
    await user.click(within(form).getByRole("button", { name: "Zapisz" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edycja wykresu" })).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Zapisz" }));

    await waitFor(() => expect(state.layout).not.toBeNull());
    const widget = (state.layout as DashboardLayout).widgets[0];
    const cfg = widget.type === "chart" ? widget.config : null;
    expect(cfg?.queries.map((q) => [q.id, q.source.kind, q.offset_min])).toEqual([
      ["A", "wan", 0],
      ["B", "wan", 1440],
      ["C", "server", 0],
    ]);
    expect(cfg?.queries[2].series.every((s) => s.axis === "right")).toBe(true);
    expect(cfg?.thresholds).toEqual([{ value: 800_000_000, color: 4 }]); // 800 Mb/s w bit/s
    expect(cfg?.legend).toEqual({ mode: "table", placement: "bottom", values: ["max"] });
  });

  it("nie zapisze niepoprawnej osi i usuwa zapytanie", async () => {
    mockApi({ layout: layoutWith(newChartConfig({ kind: "wan" })) });
    renderApp();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edytuj pulpit" }));
    await user.click(screen.getByRole("button", { name: "Edytuj: Ruch WAN" }));
    const form = await screen.findByRole("dialog", { name: "Edycja wykresu" });
    expect(within(form).queryByRole("button", { name: "Usuń zapytanie A" })).not.toBeInTheDocument(); // jedyne zapytanie zostaje
    await user.click(within(form).getByRole("button", { name: "Dodaj źródło" }));
    await user.click(within(form).getByRole("button", { name: "Usuń zapytanie B" }));
    expect(within(form).queryByRole("region", { name: "Zapytanie B" })).not.toBeInTheDocument();

    await user.type(within(form).getAllByLabelText("Minimum")[0], "100");
    await user.type(within(form).getAllByLabelText("Maksimum")[0], "50");
    await user.click(within(form).getByRole("button", { name: "Zapisz" }));
    expect(within(form).getByText("Maksimum musi być większe niż minimum.")).toBeInTheDocument();
  });
});
