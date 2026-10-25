import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setPublicDashboard } from "../lib/api";
import type { DashboardFull, PublicDashboard } from "../lib/dashboards";
import { newWidget } from "../lib/layout";
import { mockApi } from "../test/mockApi";
import { renderApp } from "../test/renderApp";

const SUMMARY_ONLY = { version: 1 as const, widgets: [newWidget("summary", "sum")] };

const WALL: DashboardFull = {
  id: 2,
  name: "Salon",
  is_default: false,
  widgets: 1,
  updated_at: "2026-10-25T12:00:00Z",
  public: null,
  layout: SUMMARY_ONLY,
};

afterEach(() => setPublicDashboard(null));

describe("kreator dashboardów", () => {
  it("tworzy publiczny wyświetlacz ścienny z PIN-em i pokazuje link", async () => {
    const { state, calls } = mockApi();
    renderApp("/settings/dashboards");
    const user = userEvent.setup();
    expect(await screen.findByText(/Nie masz jeszcze własnych pulpitów/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Nowy dashboard" }));
    const dialog = await screen.findByRole("dialog");

    await user.click(within(dialog).getByRole("button", { name: "Dalej" }));
    expect(within(dialog).getByText("Podaj nazwę pulpitu.")).toBeInTheDocument(); // nazwa wymagana
    await user.type(within(dialog).getByLabelText("Nazwa"), "Salon – telewizor");
    await user.click(within(dialog).getByRole("radio", { name: /Wyświetlacz ścienny/ }));
    await user.click(within(dialog).getByRole("button", { name: "Dalej" }));

    const widgets = within(dialog).getByRole("list", { name: "Widgety pulpitu" });
    expect(within(widgets).getAllByRole("listitem")).toHaveLength(4);
    await user.click(within(dialog).getByRole("button", { name: "Dodaj widget" })); // domyślnie wykres
    expect(within(widgets).getAllByRole("listitem")).toHaveLength(5);
    await user.click(within(dialog).getByRole("button", { name: "Dalej" }));

    // Szablon ściany od razu proponuje pulpit publiczny
    expect(within(dialog).getByRole("radio", { name: /Publiczny/ })).toBeChecked();
    await user.type(within(dialog).getByLabelText("PIN (opcjonalnie)"), "12a");
    await user.click(within(dialog).getByRole("button", { name: "Dalej" }));
    expect(within(dialog).getByText("PIN to od 4 do 12 cyfr.")).toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText("PIN (opcjonalnie)"));
    await user.type(within(dialog).getByLabelText("PIN (opcjonalnie)"), "2468");
    await user.click(within(dialog).getByRole("button", { name: "Dalej" }));

    expect(within(dialog).getByText("Salon – telewizor")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Utwórz" }));

    const done = await screen.findByRole("dialog", { name: /Gotowe: Salon – telewizor/ });
    const link = within(done).getByLabelText("Link do pulpitu") as HTMLInputElement;
    expect(link.value).toMatch(/\/p\/tok1-/);
    expect(within(done).getByRole("img", { name: "Kod QR z linkiem do pulpitu" })).toHaveAttribute("src", expect.stringContaining("/api/dashboards/1/public/qr.svg"));
    const created = calls.find((c) => c.method === "POST" && c.path === "/api/dashboards");
    expect((created?.body as { layout: { widgets: unknown[] } }).layout.widgets).toHaveLength(5);
    const shared = calls.find((c) => c.method === "PUT" && c.path === "/api/dashboards/1/public");
    expect(shared?.body).toMatchObject({ enabled: true, pin: "2468", options: { hide_hosts: true } });
    expect(state.dashboards[0].public?.has_pin).toBe(true);
  });

  it("lista: udostępnianie, wymiana linku i wyłączenie", async () => {
    const { state } = mockApi({ dashboards: [{ ...WALL }] });
    renderApp("/settings/dashboards");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Udostępnianie" }));
    const dialog = await screen.findByRole("dialog", { name: "Udostępnianie: Salon" });
    await user.click(within(dialog).getByRole("radio", { name: /Publiczny/ }));
    await user.click(within(dialog).getByRole("button", { name: "Zapisz" }));
    expect(await within(dialog).findByText("Zapisano. Pulpit jest publiczny.")).toBeInTheDocument();
    const first = state.dashboards[0].public?.token;
    await user.click(within(dialog).getByRole("button", { name: "Wymień link" }));
    await waitFor(() => expect((within(dialog).getByLabelText("Link do pulpitu") as HTMLInputElement).value).toContain("-nowy"));
    expect(state.dashboards[0].public?.token).not.toBe(first);

    await user.click(within(dialog).getByRole("radio", { name: /Prywatny/ }));
    await user.click(within(dialog).getByRole("button", { name: "Zapisz" }));
    expect(await within(dialog).findByText(/poprzedni link przestał działać/)).toBeInTheDocument();
    expect(state.dashboards[0].public).toBeNull();
  });

  it("przełącznik pulpitów na stronie Dashboard", async () => {
    mockApi({ dashboards: [{ ...WALL }] });
    renderApp();
    const user = userEvent.setup();
    const select = await screen.findByRole("combobox", { name: "Wybierz pulpit" });
    await user.selectOptions(select, "Salon");
    expect(await screen.findByRole("heading", { level: 1, name: "Salon" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/dashboards/2");
  });
});

describe("pulpit publiczny /p/<token>", () => {
  const PUBLIC: PublicDashboard = {
    name: "Salon",
    locked: false,
    layout: SUMMARY_ONLY,
    options: { refresh_s: 30, range_min: 60, hide_hosts: true },
  };

  it("otwiera się bez logowania, a widgety biorą dane z API publicznego", async () => {
    const { calls } = mockApi({ authenticated: false, publicDashboard: PUBLIC });
    renderApp("/p/token-testowy-1234567890");
    expect(await screen.findByRole("heading", { level: 1, name: "Salon" })).toBeInTheDocument();
    expect(await screen.findByText("Urządzenia")).toBeInTheDocument(); // kafelek podsumowania
    expect(screen.queryByRole("button", { name: /Zaloguj/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument(); // bez menu panelu
    expect(calls.some((c) => c.path === "/api/public/dashboards/token-testowy-1234567890/data?path=%2Fapi%2Fdashboard%2Fsummary")).toBe(true);
  });

  it("z PIN-em: najpierw formularz, po poprawnym PIN-ie pulpit", async () => {
    mockApi({ authenticated: false, publicDashboard: PUBLIC, publicPin: "2468" });
    renderApp("/p/token-testowy-1234567890");
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("PIN"), "0000");
    await user.click(screen.getByRole("button", { name: "Otwórz pulpit" }));
    expect(await screen.findByText("Nieprawidłowy PIN")).toBeInTheDocument();
    await user.clear(screen.getByLabelText("PIN"));
    await user.type(screen.getByLabelText("PIN"), "2468");
    await user.click(screen.getByRole("button", { name: "Otwórz pulpit" }));
    expect(await screen.findByText("Urządzenia")).toBeInTheDocument();
  });

  it("nieaktywny link: komunikat", async () => {
    mockApi({ authenticated: false, publicDashboard: null });
    renderApp("/p/token-testowy-1234567890");
    expect(await screen.findByText("Link nieaktywny")).toBeInTheDocument();
  });
});
