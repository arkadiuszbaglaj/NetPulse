import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { addWidgets, newWidget, placeWidgets, type DashboardLayout, type Widget } from "../lib/layout";
import { WIDGET_TEMPLATES, deviceSection, normalize, templatesForDevice } from "../lib/widgetTemplates";
import { CLASSIC_LAYOUT } from "../test/layouts";
import { DEVICE, mockApi } from "../test/mockApi";
import { renderApp } from "../test/renderApp";

const layout = (s: DashboardLayout | null) => s as DashboardLayout;

describe("szablony widgetów", () => {
  it("każdy szablon buduje widget o domyślnej szerokości z listy rozmiarów", () => {
    const port = { id: 11, if_index: 1, name: "eth0", label: "Port 1", alias: "AP", role: "lan", hidden: false, mac: null, admin_up: true, oper_status: "up", speed_mbps: 1000, in_bps: 1, out_bps: 1 };
    for (const tpl of WIDGET_TEMPLATES) {
      const w = tpl.build({ device: DEVICE, port, ports: [port], check: { id: 1, name: "Google" } });
      expect(w.w, tpl.id).toBe(tpl.sizes[0]);
    }
  });

  it("ruch na porcie: próg z prędkości łącza i porównanie z wczoraj", () => {
    const tpl = WIDGET_TEMPLATES.find((x) => x.id === "port_traffic")!;
    const port = { id: 45, if_index: 7, name: "0/7", label: "Port 7", alias: "Telewizor", role: "lan", hidden: false, mac: null, admin_up: true, oper_status: "up", speed_mbps: 100, in_bps: 1, out_bps: 1 };
    const w = tpl.build({ device: { ...DEVICE, kind: "switch", name: "USW" }, port, options: { limitLine: true, compare: true } });
    expect(w.type === "chart" && w.config.thresholds).toEqual([{ value: 100_000_000, color: 4 }]);
    expect(w.type === "chart" && w.config.queries.map((q) => q.offset_min)).toEqual([0, 1440]);
    expect(w.type === "chart" && w.config.title).toBe("Telewizor – USW");
  });

  it("według urządzenia: switch dostaje porty i PoE, sekcja ma nagłówek z nazwą", () => {
    const sw = { ...DEVICE, kind: "switch", name: "USW Lite 8 PoE" };
    const ids = templatesForDevice(sw).map((x) => x.id);
    expect(ids).toEqual(expect.arrayContaining(["ports_table", "ports_top", "poe", "port_traffic"]));
    expect(ids).not.toContain("wifi_networks");
    const section = deviceSection(sw, {});
    expect(section[0]).toMatchObject({ type: "section", config: { title: "USW Lite 8 PoE" } });
    expect(section.slice(1).map((w) => w.type)).toEqual(expect.arrayContaining(["table", "bargauge", "poe"]));
    // Moduł UniFi wyłączony – bez PoE
    expect(templatesForDevice(sw, (m) => m !== "unifi").map((x) => x.id)).not.toContain("poe");
  });

  it("szukanie bez polskich znaków i wielkości liter", () => {
    expect(normalize("Zajętość DYSKÓW")).toBe("zajetosc dyskow");
    expect(normalize("Łącza")).toBe("lacza");
  });

  it("kilka widgetów naraz: ciasno na górze, sekcja zaczyna nowy pas, reszta zjeżdża", () => {
    const placed: DashboardLayout = { version: 1, widgets: placeWidgets(CLASSIC_LAYOUT.widgets) };
    const add: Widget[] = [
      { id: "s", type: "section", w: 12, h: 1, config: { title: "Switch", collapsed: false } },
      { ...newWidget("table", "a"), w: 6, h: 8 },
      { ...newWidget("bargauge", "b"), w: 4, h: 4 },
      { ...newWidget("poe", "c"), w: 4, h: 4 },
    ];
    const out = addWidgets(placed, add).widgets;
    const pos = (id: string) => out.find((w) => w.id === id)!;
    expect([pos("s").y, pos("a").x, pos("a").y, pos("b").x, pos("b").y, pos("c").x, pos("c").y]).toEqual([0, 0, 1, 6, 1, 6, 5]);
    expect(pos("podsumowanie").y).toBe(9); // blok ma 9 wierszy
  });
});

describe("okno „Dodaj widget”", () => {
  it("szablon bez pytań dodaje się od razu na górę", async () => {
    const { state } = mockApi();
    renderApp();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edytuj pulpit" }));
    await user.click(screen.getByRole("button", { name: "Dodaj widget" }));
    const dialog = await screen.findByRole("dialog", { name: "Dodaj widget" });
    await user.click(within(dialog).getByRole("button", { name: /^Stan sieci/ }));
    await user.click(screen.getByRole("button", { name: "Zapisz" }));
    await waitFor(() => expect(state.layout).not.toBeNull());
    expect(layout(state.layout).widgets[0].type).toBe("status");
  });

  it("ruch na porcie: pyta o urządzenie i port, potem dodaje wykres portu", async () => {
    const { state } = mockApi();
    renderApp();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edytuj pulpit" }));
    await user.click(screen.getByRole("button", { name: "Dodaj widget" }));
    const dialog = await screen.findByRole("dialog", { name: "Dodaj widget" });
    await user.type(within(dialog).getByLabelText("Szukaj szablonu"), "porcie");
    await user.click(within(dialog).getByRole("button", { name: /^Ruch na porcie/ }));
    expect(await within(dialog).findByLabelText("1. Urządzenie")).toHaveValue("1");
    await waitFor(() => expect(within(dialog).getByLabelText("2. Port")).toHaveValue("11"));
    await user.click(within(dialog).getByRole("button", { name: "Dodaj na pulpit" }));
    await user.click(screen.getByRole("button", { name: "Zapisz" }));
    await waitFor(() => expect(state.layout).not.toBeNull());
    const w = layout(state.layout).widgets[0];
    expect(w.type === "chart" && w.config.queries[0].source).toEqual({ kind: "interface", id: 11, device_id: 1 });
    expect(w.type === "chart" && w.config.thresholds).toEqual([{ value: 1_000_000_000, color: 4 }]);
  });

  it("według urządzenia: cała sekcja jednym kliknięciem", async () => {
    const { state } = mockApi();
    renderApp();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edytuj pulpit" }));
    await user.click(screen.getByRole("button", { name: "Dodaj widget" }));
    const dialog = await screen.findByRole("dialog", { name: "Dodaj widget" });
    await user.click(within(dialog).getByRole("tab", { name: "Według urządzenia" }));
    await user.click(await within(dialog).findByRole("button", { name: "Dodaj sekcję" }));
    await user.click(screen.getByRole("button", { name: "Zapisz" }));
    await waitFor(() => expect(state.layout).not.toBeNull());
    const [first, ...rest] = layout(state.layout).widgets;
    expect(first).toMatchObject({ type: "section", config: { title: "UCG Ultra" } });
    expect(rest.slice(0, 3).map((w) => w.type)).toEqual(["chart", "stat", "stat"]);
  });
});
