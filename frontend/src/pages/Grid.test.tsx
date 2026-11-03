import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  addWidget,
  applyPositions,
  hiddenBySections,
  newChartConfig,
  newWidget,
  nudgeWidget,
  placeWidgets,
  readingOrder,
  rowsToPx,
  type DashboardLayout,
  type Widget,
} from "../lib/layout";
import { fullWidthInColumns } from "../components/DashboardGrid";
import { CLASSIC_LAYOUT } from "../test/layouts";
import { mockApi } from "../test/mockApi";
import { customWidgets } from "../test/addWidget";
import { renderApp } from "../test/renderApp";

const section = (id: string, y: number, title: string, collapsed = false): Widget => ({ id, type: "section", w: 12, h: 1, x: 0, y, config: { title, collapsed } });
const pos = (widgets: Widget[]) => widgets.map((w) => [w.id, w.x, w.y, w.w, w.h]);

describe("dwie kolumny (tablet)", () => {
  it("wąskie widgety idą parami, szerokie i wąskie bez pary – na całą szerokość", () => {
    const w = (id: string, width: Widget["w"]): Widget => ({ ...newWidget("summary", id), w: width });
    const order = [w("a", 12), w("b", 8), w("c", 4), w("d", 12), w("e", 6), w("f", 6), w("g", 4)];
    expect([...fullWidthInColumns(order)]).toEqual(["a", "b", "c", "d", "g"]);
  });
});

describe("model swobodnej siatki", () => {
  it("pulpit sprzed 0.28.0 układa się po kolei jak dawne kolumny", () => {
    expect(pos(placeWidgets(CLASSIC_LAYOUT.widgets))).toEqual([
      ["podsumowanie", 0, 0, 12, 3],
      ["ruch-wan", 0, 3, 8, 8],
      ["klienci-wifi", 8, 3, 4, 8],
      ["urzadzenia", 0, 11, 12, 8],
    ]);
    expect(rowsToPx(8)).toBe(324);
  });

  it("nowy widget trafia na górę, klawiatura przesuwa i zmienia rozmiar w granicach siatki", () => {
    const placed: DashboardLayout = { version: 1, widgets: placeWidgets(CLASSIC_LAYOUT.widgets) };
    const added = addWidget(placed, newWidget("stat", "nowy"));
    // Od 0.43.4 na górze – reszta zjeżdża o jego wysokość
    expect(pos(added.widgets).slice(0, 2)).toEqual([
      ["nowy", 0, 0, 3, 4],
      ["podsumowanie", 0, 4, 12, 3],
    ]);
    // Bez zapisanych pozycji nowy widget też nie dostaje pozycji – ułoży się po kolei, jako pierwszy
    expect(addWidget(CLASSIC_LAYOUT, newWidget("stat", "n")).widgets[0]?.x).toBeUndefined();

    const moved = nudgeWidget(placed, "ruch-wan", { dx: 10 });
    expect(pos(moved.widgets)[1]).toEqual(["ruch-wan", 4, 3, 8, 8]); // dalej niż do krawędzi się nie da
    const wider = nudgeWidget(placed, "klienci-wifi", { dw: 3, dh: -20 });
    expect(pos(wider.widgets)[2]).toEqual(["klienci-wifi", 5, 3, 7, 1]); // szerszy przy prawej krawędzi przesuwa się w lewo
    const fromGrid = applyPositions(CLASSIC_LAYOUT, [{ i: "urzadzenia", x: 2, y: 30, w: 6, h: 5 }]);
    expect(pos(fromGrid.widgets)[3]).toEqual(["urzadzenia", 2, 30, 6, 5]);
  });

  it("zwinięta sekcja ukrywa widgety pod sobą, do następnej sekcji", () => {
    const widgets: Widget[] = [
      section("s1", 0, "Sieć", false),
      { ...newWidget("stat", "a"), x: 0, y: 1, h: 4 },
      { ...newWidget("stat", "b"), x: 3, y: 1, h: 4 },
      section("s2", 5, "Serwery", false),
      { ...newWidget("table", "c"), x: 0, y: 6, h: 8 },
    ];
    expect([...hiddenBySections(widgets, new Set(["s1"]))]).toEqual(["a", "b"]);
    expect([...hiddenBySections(widgets, new Set(["s2"]))]).toEqual(["c"]);
    expect(readingOrder([widgets[4], widgets[2], widgets[1]]).map((w) => w.id)).toEqual(["a", "b", "c"]);
  });
});

describe("pulpit na szerokim ekranie", () => {
  let restore: () => void;
  beforeEach(() => {
    // jsdom nie ma układu strony: kontener siatki „ma” 1400 px, więc pulpit rysuje react-grid-layout
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get() {
        return (this as HTMLElement).classList.contains("np-grid") ? 1400 : 0;
      },
    });
    restore = () => original && Object.defineProperty(HTMLElement.prototype, "clientWidth", original);
    try {
      localStorage.clear();
    } catch {
      // brak localStorage – testy zwijania sprawdzą stan domyślny
    }
  });
  afterEach(() => restore());

  it("siatka z pozycjami; strzałki na uchwycie przesuwają widget, Shift+strzałki zmieniają rozmiar", async () => {
    const { state } = mockApi();
    const { container } = renderApp();
    await screen.findByText("Ruch WAN");
    expect(container.querySelectorAll(".react-grid-item")).toHaveLength(4);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Edytuj pulpit" }));
    expect(container.querySelectorAll(".react-resizable-handle").length).toBeGreaterThan(0);
    const grip = screen.getByRole("button", { name: "Przenieś: Ruch WAN" });
    grip.focus();
    await user.keyboard("{ArrowRight}{ArrowRight}{Shift>}{ArrowDown}{/Shift}");
    await user.click(screen.getByRole("button", { name: "Zapisz" }));
    await waitFor(() => expect(state.layout).not.toBeNull());
    expect(pos((state.layout as DashboardLayout).widgets)).toEqual([
      ["podsumowanie", 0, 0, 12, 3],
      ["ruch-wan", 2, 3, 8, 9],
      ["klienci-wifi", 8, 3, 4, 8],
      ["urzadzenia", 0, 11, 12, 8],
    ]);
  });

  it("sekcje: zwinięcie ukrywa widgety pod nią i liczy je", async () => {
    const layout: DashboardLayout = {
      version: 1,
      widgets: [
        section("s1", 0, "Internet", true),
        { id: "wan", type: "chart", w: 12, x: 0, y: 1, h: 8, config: newChartConfig({ kind: "wan" }) },
        section("s2", 9, "Sieć lokalna", false),
        { id: "wifi", type: "chart", w: 12, x: 0, y: 10, h: 8, config: newChartConfig({ kind: "wifi_total" }) },
      ],
    };
    mockApi({ layout });
    renderApp();
    await screen.findByText("Klienci WiFi");
    const internet = await screen.findByRole("button", { name: /Internet/ });
    expect(internet).toHaveAttribute("aria-expanded", "false"); // zwinięta z konfiguracji
    expect(internet).toHaveTextContent("(ukryte: 1)");
    expect(screen.queryByText("Ruch WAN")).not.toBeInTheDocument();
    expect(screen.getByText("Klienci WiFi")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(internet);
    expect(await screen.findByText("Ruch WAN")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Sieć lokalna/ }));
    expect(screen.queryByText("Klienci WiFi")).not.toBeInTheDocument();
  });

  it("nowa sekcja z kreatora trafia na górę pulpitu", async () => {
    const { state } = mockApi();
    renderApp();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edytuj pulpit" }));
    await user.click(screen.getByRole("button", { name: "Dodaj widget" }));
    await user.click(within(await customWidgets(user)).getByRole("button", { name: /Sekcja/ }));
    const form = await screen.findByRole("dialog", { name: "Nowa sekcja" });
    await user.click(within(form).getByRole("button", { name: "Zapisz" }));
    expect(within(form).getByText("Podaj nazwę sekcji.")).toBeInTheDocument();
    await user.type(within(form).getByLabelText("Nazwa sekcji"), "Serwery");
    await user.click(within(form).getByRole("button", { name: "Zapisz" }));
    await user.click(screen.getByRole("button", { name: "Zapisz" }));
    await waitFor(() => expect(state.layout).not.toBeNull());
    const first = (state.layout as DashboardLayout).widgets[0];
    expect(first).toMatchObject({ type: "section", w: 12, h: 1, x: 0, y: 0, config: { title: "Serwery", collapsed: false } });
  });
});
