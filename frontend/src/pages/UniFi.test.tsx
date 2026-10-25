import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { formatLinkRate, formatWatts, signalQuality } from "../lib/unifi";
import { newWidget } from "../lib/layout";
import { CLIENTS, CONTROLLER, DEVICE, POE, mockApi } from "../test/mockApi";
import { renderApp } from "../test/renderApp";

describe("pomocnicze funkcje UniFi", () => {
  it("ocenia siłę sygnału WiFi", () => {
    expect(signalQuality(-45)).toBe("great");
    expect(signalQuality(-60)).toBe("good");
    expect(signalQuality(-70)).toBe("fair");
    expect(signalQuality(-85)).toBe("weak");
    expect(signalQuality(null)).toBeNull();
  });

  it("formatują prędkość łącza i waty", () => {
    expect(formatLinkRate(866000)).toBe("866 Mb/s");
    expect(formatLinkRate(null)).toBe("–");
    expect(formatWatts(3.89)).toBe("3,9 W");
    expect(formatWatts(null)).toBe("–");
  });
});

describe("Ustawienia → Kontrolery UniFi", () => {
  it("pokazuje podpowiedź, gdy nie ma kontrolera", async () => {
    mockApi();
    renderApp("/settings/controllers");
    expect(await screen.findByText("Nie dodano jeszcze kontrolera")).toBeInTheDocument();
  });

  it("wypisuje kontrolery ze statusem i wersją", async () => {
    mockApi({ controllers: [{ ...CONTROLLER }] });
    renderApp("/settings/controllers");
    expect(await screen.findByText("UniFi")).toBeInTheDocument();
    expect(screen.getByText(/192\.168\.1\.1:443/)).toHaveTextContent("UniFi Network 10.6.109");
    expect(screen.getByText("działa")).toBeInTheDocument();
  });

  it("dodaje kontroler po teście połączenia i nie wyświetla klucza", async () => {
    const { calls, state } = mockApi();
    renderApp("/settings/controllers");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Dodaj kontroler" }));

    const form = await screen.findByRole("dialog", { name: "Dodaj kontroler UniFi" });
    await user.type(within(form).getByLabelText("Nazwa"), "Dom");
    await user.type(within(form).getByLabelText("Adres IP lub nazwa hosta"), "192.168.1.1");
    await user.type(within(form).getByLabelText("Klucz API"), "tajny-klucz-123");

    await user.click(within(form).getByRole("button", { name: "Testuj połączenie" }));
    expect(await within(form).findByText(/UniFi Network 10\.6\.109: urządzeń 3, klientów 9/)).toBeInTheDocument();

    await user.click(within(form).getByRole("button", { name: "Zapisz" }));
    await waitFor(() => expect(state.controllers).toHaveLength(1));
    expect(calls.find((c) => c.method === "POST" && c.path === "/api/controllers")?.body).toMatchObject({
      name: "Dom",
      host: "192.168.1.1",
      api_key: "tajny-klucz-123",
      port: 443,
      site: "default",
    });
    expect(await screen.findByText("Dom")).toBeInTheDocument();
    expect(screen.queryByText("tajny-klucz-123")).not.toBeInTheDocument();
  });

  it("waliduje formularz i pokazuje błąd kontrolera", async () => {
    mockApi();
    renderApp("/settings/controllers");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Dodaj kontroler" }));
    const form = await screen.findByRole("dialog", { name: "Dodaj kontroler UniFi" });

    await user.click(within(form).getByRole("button", { name: "Zapisz" }));
    expect(await within(form).findByText("Podaj nazwę.")).toBeInTheDocument();
    expect(within(form).getByText("Klucz API ma co najmniej 8 znaków.")).toBeInTheDocument();

    await user.type(within(form).getByLabelText("Nazwa"), "Dom");
    await user.type(within(form).getByLabelText("Adres IP lub nazwa hosta"), "192.168.1.1");
    await user.type(within(form).getByLabelText("Klucz API"), "zly-klucz-api");
    await user.click(within(form).getByRole("button", { name: "Testuj połączenie" }));
    expect(await within(form).findByText("Kontroler odrzucił klucz API")).toBeInTheDocument();
  });

  it("edycja bez nowego klucza nie wysyła klucza, a usuwanie wymaga potwierdzenia", async () => {
    const { calls, state } = mockApi({ controllers: [{ ...CONTROLLER }] });
    renderApp("/settings/controllers");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edytuj UniFi" }));
    const form = await screen.findByRole("dialog", { name: "Edycja: UniFi" });
    const name = within(form).getByLabelText("Nazwa");
    await user.clear(name);
    await user.type(name, "Router");
    await user.click(within(form).getByRole("button", { name: "Zapisz" }));
    await waitFor(() => expect(state.controllers[0].name).toBe("Router"));
    expect(calls.find((c) => c.method === "PATCH")?.body).not.toHaveProperty("api_key");

    await user.click(await screen.findByRole("button", { name: "Usuń Router" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Usunąć kontroler?" })).getByRole("button", { name: "Usuń" }));
    await waitFor(() => expect(state.controllers).toHaveLength(0));
  });
});

describe("strona Klienci", () => {
  it("prosi o dodanie kontrolera, gdy go brak", async () => {
    mockApi();
    renderApp("/clients");
    expect(await screen.findByText("Brak kontrolera UniFi")).toBeInTheDocument();
  });

  it("pokazuje klientów WiFi z sygnałem i klientów po kablu z portem", async () => {
    mockApi({ controllers: [{ ...CONTROLLER }], clients: CLIENTS });
    renderApp("/clients");
    const wifi = await screen.findByRole("row", { name: /Telefon Ani/ });
    expect(wifi).toHaveTextContent("Dom · 5 GHz · -52 dBm");
    expect(wifi).toHaveTextContent("866 Mb/s");
    expect(screen.getByRole("row", { name: /Telewizor/ })).toHaveTextContent("USW · port 7");
  });

  it("filtruje po rodzaju połączenia i po wyszukiwanej frazie", async () => {
    mockApi({ controllers: [{ ...CONTROLLER }], clients: CLIENTS });
    renderApp("/clients");
    const user = userEvent.setup();
    await screen.findByRole("row", { name: /Telewizor/ });

    await user.click(screen.getByRole("button", { name: "WiFi" }));
    expect(screen.queryByRole("row", { name: /Telewizor/ })).not.toBeInTheDocument();
    expect(screen.getByRole("row", { name: /Telefon Ani/ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Wszyscy" }));
    await user.type(screen.getByRole("searchbox", { name: "Szukaj klienta" }), "192.168.1.60");
    expect(screen.queryByRole("row", { name: /Telefon Ani/ })).not.toBeInTheDocument();
    expect(screen.getByRole("row", { name: /Telewizor/ })).toBeInTheDocument();
  });
});

describe("widget PoE", () => {
  it("pokazuje moc na portach i budżet switcha", async () => {
    const switchDevice = { ...DEVICE, id: 2, name: "USW", kind: "switch" };
    mockApi({
      devices: [DEVICE, switchDevice],
      poe: POE,
      layout: { version: 1, widgets: [newWidget("poe", "poe1")] },
    });
    renderApp();
    expect(await screen.findByText("PoE: USW")).toBeInTheDocument();
    expect(screen.getByText("3,9 W z 52 W")).toBeInTheDocument();
    expect(screen.getByRole("meter", { name: "Wykorzystanie budżetu PoE" })).toHaveAttribute("aria-valuenow", "8");
    expect(screen.getByText("AP U6+")).toBeInTheDocument();
    expect(screen.getByText("wyłączone")).toBeInTheDocument();
  });
});
