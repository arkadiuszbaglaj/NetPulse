import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockApi } from "../test/mockApi";
import { renderApp } from "../test/renderApp";

describe("paleta poleceń (Ctrl+K)", () => {
  it("otwiera się skrótem, szuka urządzeń i portów, Enter przechodzi do wyniku", async () => {
    const user = userEvent.setup();
    mockApi();
    renderApp();
    await screen.findByRole("navigation", { name: "Menu główne" });
    await user.keyboard("{Control>}k{/Control}");
    const dialog = await screen.findByRole("dialog", { name: "Szukaj w panelu" });
    const input = within(dialog).getByRole("combobox");
    expect(input).toHaveFocus();
    // Bez zapytania: strony i urządzenia
    expect(await within(dialog).findByRole("option", { name: /UCG Ultra/ })).toBeInTheDocument();
    expect(within(dialog).getByRole("option", { name: "Dashboard" })).toBeInTheDocument();

    // Port szukany po opisie z urządzenia (alias) – dane portów dochodzą po otwarciu palety
    await user.type(input, "u6");
    const port = await within(dialog).findByRole("option", { name: /Port 1/ });
    expect(port).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("dialog", { name: "Szukaj w panelu" })).not.toBeInTheDocument();
    expect(await screen.findByRole("heading", { level: 1, name: /Port 1/ })).toBeInTheDocument();
  });

  it("przycisk w pasku górnym otwiera paletę, Escape zamyka, strony Ustawień są w wynikach", async () => {
    const user = userEvent.setup();
    mockApi();
    renderApp();
    await user.click(await screen.findByRole("button", { name: "Szukaj w panelu (Ctrl+K)" }));
    const dialog = await screen.findByRole("dialog", { name: "Szukaj w panelu" });
    await user.type(within(dialog).getByRole("combobox"), "lacza");
    expect(within(dialog).getByRole("option", { name: /Łącza WAN/ })).toBeInTheDocument();
    await user.type(within(dialog).getByRole("combobox"), "zzz");
    expect(within(dialog).getByText("Nic nie pasuje do zapytania.")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Szukaj w panelu" })).not.toBeInTheDocument();
  });
});

describe("skrót stanu sieci w menu", () => {
  it("pokazuje zdanie o stanie, liczbę urządzeń i ruch WAN", async () => {
    mockApi();
    renderApp();
    const status = await screen.findByRole("link", { name: "Stan sieci" });
    // Atrapa: 3 z 4 urządzeń działa – skrót prowadzi do alertów
    expect(status).toHaveTextContent("Nie odpowiada urządzeń: 1");
    expect(status).toHaveTextContent("3 z 4 urządzeń online");
    expect(status).toHaveTextContent("WAN ↓ 42,3 Mb/s · ↑ 6,5 Mb/s");
    expect(status).toHaveAttribute("href", "/alerts");
  });

  it("gdy wszystko działa, prowadzi na pulpit; bez portu WAN nie pokazuje ruchu", async () => {
    mockApi({ summary: { devices: { total: 3, up: 3, down: 0, unknown: 0 }, wan: { in_bps: null, out_bps: null, interfaces: 0 }, wifi_clients: null, last_poll_at: null, poll_interval_s: 30 } });
    renderApp();
    const status = await screen.findByRole("link", { name: "Stan sieci" });
    expect(status).toHaveTextContent("Sieć działa prawidłowo");
    expect(status).toHaveTextContent("3 z 3 urządzeń online");
    expect(status).not.toHaveTextContent("WAN");
    expect(status).toHaveAttribute("href", "/");
  });
});
