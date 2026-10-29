import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { lastDays } from "../components/Availability";
import { CLIENTS, DEVICE, PORT, mockApi } from "../test/mockApi";
import { renderApp } from "../test/renderApp";

const SWITCH = { ...DEVICE, id: 1, name: "USW Lite", kind: "switch" };

describe("strona urządzenia", () => {
  it("karta na pulpicie prowadzi do szczegółów z dostępnością, wykresami i portami", async () => {
    mockApi();
    renderApp();
    const user = userEvent.setup();
    expect(await screen.findByText("Dostępność 30 dni: 99,50%")).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "UCG Ultra" }));

    expect(await screen.findByRole("heading", { level: 1, name: "UCG Ultra" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/devices/1");
    expect(screen.getByText("Informacje")).toBeInTheDocument();
    // Dostępność: 24 godz., 7 dni, 30 dni, rok – i pasek ostatnich 30 dni
    await waitFor(() => expect(screen.getAllByText("99,50%")).toHaveLength(4));
    expect(screen.getByRole("list", { name: /dzień po dniu/ }).children).toHaveLength(30);
    expect(screen.getByText("Procesor i pamięć")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Zakres czasu" })).toBeInTheDocument();

    const port = await screen.findByRole("link", { name: "Port 1" });
    expect(port).toHaveAttribute("href", "/devices/1/ports/11");
    expect(screen.getByText("Sieci WiFi")).toBeInTheDocument();
  });

  it("pokazuje klientów podłączonych do urządzenia", async () => {
    const client = { ...CLIENTS[0], uplink_device_id: 1 };
    mockApi({ clients: [client, { ...CLIENTS[0], mac: "aa:bb:cc:00:00:99", name: "Inny", uplink_device_id: 7 }] });
    renderApp("/devices/1");
    const table = (await screen.findByText(/Podłączeni klienci/)).closest("div")!;
    expect(within(table).getByText(client.name ?? client.mac)).toBeInTheDocument();
    expect(within(table).queryByText("Inny")).not.toBeInTheDocument();
  });

  it("usunięte urządzenie: komunikat zamiast strony", async () => {
    mockApi({ devices: [] });
    renderApp("/devices/42");
    expect(await screen.findByText(/Nie ma takiego urządzenia/)).toBeInTheDocument();
    // Powrót na pulpit: link w treści strony obok pozycji w menu
    expect(screen.getAllByRole("link", { name: "Dashboard" }).length).toBeGreaterThan(1);
  });
});

describe("strona portu", () => {
  it("pokazuje stan, dostępność łącza, ruch, błędy i PoE", async () => {
    mockApi({ devices: [SWITCH], port: { ...PORT, device_name: "USW Lite" } });
    renderApp("/devices/1/ports/11");
    expect(await screen.findByRole("heading", { level: 1, name: "Port 1 · USW Lite" })).toBeInTheDocument();
    expect(screen.getByText("AP U6+")).toBeInTheDocument();
    expect(screen.getByText("podłączony")).toBeInTheDocument();
    expect(screen.getByText("1 Gb/s")).toBeInTheDocument();
    expect(screen.getByText("Dostępność łącza (port podłączony)")).toBeInTheDocument();
    expect(screen.getByText("Ruch na porcie")).toBeInTheDocument();
    expect(screen.getByText("Błędy i odrzucone pakiety")).toBeInTheDocument();
    expect(await screen.findByText("Moc PoE")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "USW Lite" })).toHaveAttribute("href", "/devices/1");
  });

  it("port bez PoE nie pokazuje wykresu mocy", async () => {
    mockApi({ port: { ...PORT, poe_port_idx: null } });
    renderApp("/devices/1/ports/11");
    await screen.findByText("Ruch na porcie");
    expect(screen.queryByText("Moc PoE")).not.toBeInTheDocument();
  });
});

describe("pasek dostępności dzień po dniu", () => {
  it("uzupełnia dni bez próbek i kończy na dzisiaj", () => {
    const days = lastDays([{ day: "2026-10-24", percent: 98, samples: 10 }], 3, new Date(2026, 9, 25, 12));
    expect(days.map((d) => [d.key, d.percent])).toEqual([
      ["2026-10-23", null],
      ["2026-10-24", 98],
      ["2026-10-25", null],
    ]);
  });
});
