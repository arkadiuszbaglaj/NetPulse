import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  DEFAULT_LAYOUT,
  addWidget,
  dropOn,
  moveWidget,
  newWidget,
  removeWidget,
  resizeWidget,
  shiftWidget,
  toggleMetric,
  yMaxFromRaw,
  yMaxToRaw,
} from "../lib/layout";
import { mockApi } from "../test/mockApi";
import { renderApp } from "../test/renderApp";

const ids = (l: typeof DEFAULT_LAYOUT) => l.widgets.map((w) => w.id);

describe("operacje na układzie pulpitu", () => {
  it("przesuwa widget i nie mutuje wejścia", () => {
    const moved = shiftWidget(DEFAULT_LAYOUT, "podsumowanie", 1);
    expect(ids(moved)).toEqual(["ruch-wan", "podsumowanie", "klienci-wifi", "urzadzenia"]);
    expect(ids(DEFAULT_LAYOUT)[0]).toBe("podsumowanie");
  });

  it("nie wychodzi poza zakres przy przesuwaniu", () => {
    expect(shiftWidget(DEFAULT_LAYOUT, "podsumowanie", -1)).toBe(DEFAULT_LAYOUT);
    expect(moveWidget(DEFAULT_LAYOUT, "podsumowanie", 99).widgets.at(-1)?.id).toBe("podsumowanie");
  });

  it("upuszczenie na inny widget zajmuje jego miejsce", () => {
    expect(ids(dropOn(DEFAULT_LAYOUT, "urzadzenia", "ruch-wan"))).toEqual(["podsumowanie", "urzadzenia", "ruch-wan", "klienci-wifi"]);
    expect(dropOn(DEFAULT_LAYOUT, "urzadzenia", "urzadzenia")).toBe(DEFAULT_LAYOUT);
  });

  it("zmienia szerokość, usuwa i dodaje widgety", () => {
    expect(resizeWidget(DEFAULT_LAYOUT, "ruch-wan", 12).widgets[1].w).toBe(12);
    expect(ids(removeWidget(DEFAULT_LAYOUT, "ruch-wan"))).not.toContain("ruch-wan");
    expect(addWidget(DEFAULT_LAYOUT, newWidget("chart", "nowy")).widgets.at(-1)?.id).toBe("nowy");
  });

  it("metryki w jednym wykresie mają tę samą jednostkę", () => {
    const series = toggleMetric([{ key: "in_bps", color: 1 }], "in_errors", true);
    expect(series.map((s) => s.key)).toEqual(["in_errors"]);
    expect(toggleMetric(series, "in_errors", false)).toEqual([]);
  });

  it("przelicza maksimum osi Y między jednostką widoczną a surową", () => {
    expect(yMaxToRaw(100, "in_bps", "bits")).toBe(100_000_000);
    expect(yMaxToRaw(10, "in_bps", "bytes")).toBe(80_000_000);
    expect(yMaxFromRaw(80_000_000, "in_bps", "bytes")).toBe(10);
    expect(yMaxToRaw(90, "cpu_percent", "bits")).toBe(90);
  });
});

describe("edycja pulpitu", () => {
  it("pokazuje układ domyślny, gdy nic nie zapisano", async () => {
    mockApi();
    renderApp();
    expect(await screen.findAllByTestId("chart")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Edytuj pulpit" })).toBeInTheDocument();
  });

  it("zapisuje zmieniony układ na koncie dopiero po kliknięciu „Zapisz”", async () => {
    const { calls, state } = mockApi();
    renderApp();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edytuj pulpit" }));
    expect(screen.getByRole("button", { name: "Zapisz" })).toBeDisabled(); // brak zmian

    await user.click(screen.getByRole("button", { name: "Usuń: Klienci WiFi" }));
    expect(calls.some((c) => c.method === "PUT")).toBe(false);

    await user.click(screen.getByRole("button", { name: "Zapisz" }));
    await waitFor(() => expect(state.layout?.widgets.map((w) => w.id)).toEqual(["podsumowanie", "ruch-wan", "urzadzenia"]));
    expect(screen.getByRole("button", { name: "Edytuj pulpit" })).toBeInTheDocument(); // wyjście z edycji
    expect(screen.getAllByTestId("chart")).toHaveLength(1);
  });

  it("pyta o potwierdzenie przy anulowaniu niezapisanych zmian", async () => {
    const { state } = mockApi();
    renderApp();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edytuj pulpit" }));
    await user.click(screen.getByRole("button", { name: "Usuń: Klienci WiFi" }));
    await user.click(screen.getByRole("button", { name: "Anuluj" }));

    const dialog = await screen.findByRole("dialog", { name: "Odrzucić zmiany?" });
    await user.click(within(dialog).getByRole("button", { name: "Odrzuć zmiany" }));
    expect(state.layout).toBeNull();
    expect(await screen.findAllByTestId("chart")).toHaveLength(2);
  });

  it("dodaje nowy wykres wybrany w kreatorze", async () => {
    const { state } = mockApi();
    renderApp();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edytuj pulpit" }));
    await user.click(screen.getByRole("button", { name: "Dodaj widget" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Dodaj widget" })).getByRole("button", { name: /Wykres/ }));

    const form = await screen.findByRole("dialog", { name: "Nowy wykres" });
    await user.type(within(form).getByLabelText("Tytuł"), "Mój ruch");
    await user.click(within(form).getByRole("button", { name: "Zapisz" }));
    await user.click(screen.getByRole("button", { name: "Zapisz" }));

    await waitFor(() => expect(state.layout?.widgets).toHaveLength(5));
    const added = state.layout?.widgets.at(-1);
    expect(added?.type).toBe("chart");
    expect(added && added.type === "chart" && added.config.title).toBe("Mój ruch");
  });

  it("wykres z portu wymaga wyboru urządzenia i portu", async () => {
    mockApi();
    renderApp();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edytuj pulpit" }));
    await user.click(screen.getByRole("button", { name: "Dodaj widget" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Dodaj widget" })).getByRole("button", { name: /Wykres/ }));

    const form = await screen.findByRole("dialog", { name: "Nowy wykres" });
    await user.selectOptions(within(form).getByLabelText("Źródło danych"), "interface");
    await user.click(within(form).getByRole("button", { name: "Zapisz" }));
    expect(await within(form).findByText("Wybierz źródło danych.")).toBeInTheDocument();

    await user.selectOptions(within(form).getByLabelText("Urządzenie"), "1");
    await user.selectOptions(await within(form).findByLabelText("Port"), "11");
    await user.click(within(form).getByRole("button", { name: "Zapisz" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Nowy wykres" })).not.toBeInTheDocument());
  });

  it("przywraca układ domyślny po potwierdzeniu", async () => {
    const { state, calls } = mockApi({ layout: { version: 1, widgets: [newWidget("devices", "tylko-urzadzenia")] } });
    renderApp();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edytuj pulpit" }));
    await user.click(screen.getByRole("button", { name: "Przywróć domyślny" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Przywróć" }));

    await waitFor(() => expect(state.layout).toBeNull());
    expect(calls.some((c) => c.method === "DELETE" && c.path === "/api/dashboards/default")).toBe(true);
    expect(await screen.findAllByTestId("chart")).toHaveLength(2);
  });

  it("pokazuje błąd, gdy zapis się nie uda, i zostaje w trybie edycji", async () => {
    mockApi({ overrides: { "PUT /api/dashboards/default": { status: 500, body: { detail: "awaria" } } } });
    renderApp();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edytuj pulpit" }));
    await user.click(screen.getByRole("button", { name: "Usuń: Klienci WiFi" }));
    await user.click(screen.getByRole("button", { name: "Zapisz" }));
    expect(await screen.findByText("Nie udało się zapisać pulpitu.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Zapisz" })).toBeInTheDocument();
  });
});
