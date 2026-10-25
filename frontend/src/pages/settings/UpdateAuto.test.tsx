import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UPDATE_AVAILABLE, UPDATES, UP_TO_DATE, mockApi } from "../../test/mockApi";
import { renderApp } from "../../test/renderApp";

const available = { ...UPDATES, info: UPDATE_AVAILABLE };

describe("plakietka o aktualizacji w pasku górnym", () => {
  it("pokazuje link do ustawień, gdy po sprawdzeniu jest nowa wersja", async () => {
    mockApi({ updates: available });
    renderApp();
    const link = await screen.findByRole("link", { name: "Nowa wersja 0.3.0" });
    expect(link).toHaveAttribute("href", "/settings/update");
  });

  it("nie pokazuje się, gdy wersja jest aktualna albo nic nie sprawdzano", async () => {
    mockApi({ updates: { ...UPDATES, info: UP_TO_DATE } });
    renderApp();
    await screen.findByRole("heading", { name: "Dashboard" });
    expect(screen.queryByRole("link", { name: /Nowa wersja/ })).not.toBeInTheDocument();
  });

  it("nie pokazuje się, gdy usługa aktualizacji jest niedostępna", async () => {
    mockApi({ updates: { ...available, updater: { configured: true, reachable: false, message: "x" } } });
    renderApp();
    await screen.findByRole("heading", { name: "Dashboard" });
    expect(screen.queryByRole("link", { name: /Nowa wersja/ })).not.toBeInTheDocument();
  });

  it("można ją ukryć do następnej wersji", async () => {
    mockApi({ updates: available });
    const first = renderApp();
    const user = userEvent.setup();
    await screen.findByRole("link", { name: "Nowa wersja 0.3.0" });
    await user.click(screen.getByRole("button", { name: "Ukryj powiadomienie o tej wersji" }));
    expect(screen.queryByRole("link", { name: /Nowa wersja/ })).not.toBeInTheDocument();
    expect(localStorage.getItem("netpulse.updateDismissed")).toBe("def5678");

    first.unmount();
    mockApi({ updates: available });
    renderApp();
    await screen.findByRole("heading", { name: "Dashboard" });
    expect(screen.queryByRole("link", { name: /Nowa wersja/ })).not.toBeInTheDocument();
  });
});

describe("ustawienia automatycznego sprawdzania", () => {
  it("administrator wyłącza sprawdzanie i zmienia częstotliwość", async () => {
    const { state, calls } = mockApi();
    renderApp("/settings/update");
    const user = userEvent.setup();

    const select = await screen.findByLabelText("Jak często sprawdzać");
    expect(select).toHaveValue("24");
    await user.selectOptions(select, "6");
    await waitFor(() => expect(state.updateSettings).toEqual({ auto_check: true, interval_h: 6 }));

    await user.click(screen.getByRole("switch", { name: "Automatycznie sprawdzaj aktualizacje" }));
    await waitFor(() => expect(state.updateSettings.auto_check).toBe(false));
    expect(calls.filter((c) => c.method === "PUT" && c.path === "/api/updates/settings")).toHaveLength(2);
    expect(await screen.findByText(/Serwer niczego nie sprawdza sam/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Jak często sprawdzać")).not.toBeInTheDocument();
  });

  it("zwykły użytkownik widzi ustawienia, ale nie może ich zmienić", async () => {
    mockApi({ admin: false });
    renderApp("/settings/update");
    const toggle = await screen.findByRole("switch", { name: "Automatycznie sprawdzaj aktualizacje" });
    expect(toggle).toBeDisabled();
    expect(screen.getByLabelText("Jak często sprawdzać")).toBeDisabled();
    expect(screen.getByText("Te ustawienia może zmienić tylko administrator.")).toBeInTheDocument();
  });
});
