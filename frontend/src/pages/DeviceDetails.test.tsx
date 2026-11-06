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
    expect(screen.getByRole("button", { name: /^Zakres czasu:/ })).toBeInTheDocument();

    const port = await screen.findByRole("link", { name: "Port 1" });
    expect(port).toHaveAttribute("href", "/devices/1/ports/11");
    expect(screen.getByText("Sieci WiFi")).toBeInTheDocument();
  });

  it("plakietka: urządzenie sprawdzone tylko na danych testowych prowadzi do listy źródeł", async () => {
    mockApi({ devices: [{ ...DEVICE, driver: "omada", verification: "test" }] });
    renderApp("/devices/1");
    const badge = await screen.findByRole("link", { name: "dane testowe" });
    expect(badge).toHaveAttribute("href", "/settings/system#verification");
    expect(badge).toHaveAttribute("title", expect.stringMatching(/tylko na danych testowych/));
  });

  it("potwierdzone urządzenie nie ma plakietki", async () => {
    mockApi({ devices: [{ ...DEVICE, verification: "verified" }] });
    renderApp("/devices/1");
    expect(await screen.findByRole("heading", { level: 1, name: "UCG Ultra" })).toBeInTheDocument();
    expect(screen.queryByText("dane testowe")).toBeNull();
    expect(screen.queryByText("częściowo potwierdzone")).toBeNull();
  });

  it("pokazuje klientów podłączonych do urządzenia", async () => {
    const client = { ...CLIENTS[0], uplink_device_id: 1 };
    mockApi({ clients: [client, { ...CLIENTS[0], mac: "aa:bb:cc:00:00:99", name: "Inny", uplink_device_id: 7 }] });
    renderApp("/devices/1");
    const table = (await screen.findByText(/Podłączeni klienci/)).closest("div")!;
    expect(within(table).getByText(client.name ?? client.mac)).toBeInTheDocument();
    expect(within(table).queryByText("Inny")).not.toBeInTheDocument();
  });

  it("czujniki MikroTika: temperatura, PoE z mocą w tabeli portów i moduł SFP bez sygnału", async () => {
    mockApi({
      sensors: {
        sensors: [
          { key: "cpu-temperature", metric: "temp_c", value: 46 },
          { key: "fan1-speed", metric: "fan_rpm", value: 4200 },
          { key: "psu1-state", metric: "sensor_state", value: 1 },
        ],
        poe: [
          { port: "eth0", state: 3, power_w: 3.6, voltage_v: 23.8 },
          { port: "ether9", state: 5, power_w: null, voltage_v: null },
        ],
        sfp: [{ port: "sfp1", rx_dbm: -31, tx_dbm: -5.871, temp_c: 41, voltage_v: 3.29, rx_loss: true, tx_fault: false }],
      },
    });
    renderApp("/devices/1");
    const sensors = (await screen.findByRole("heading", { name: "Czujniki" })).closest("div")!;
    expect(within(sensors).getByText("46 °C")).toBeInTheDocument();
    expect(within(sensors).getByText("4200 obr/min")).toBeInTheDocument();
    expect(within(sensors).getByText("stan 1")).toBeInTheDocument();

    const poe = screen.getByRole("heading", { name: "PoE" }).closest("div")!;
    expect(within(poe).getByText("zasila")).toBeInTheDocument();
    expect(within(poe).getByText("zwarcie")).toHaveClass("text-danger");
    expect(within(poe).getByText("23,8 V")).toBeInTheDocument();

    const sfp = screen.getByRole("heading", { name: "Moduły SFP" }).closest("div")!;
    expect(within(sfp).getByText("brak sygnału")).toHaveClass("text-danger");
    expect(within(sfp).getByText("-31 dBm")).toBeInTheDocument();
    expect(within(sfp).getByText("-5,9 dBm")).toBeInTheDocument();

    // Moc PoE z SNMP trafia też do tabeli portów (port „eth0” = Port 1)
    const ports = (await screen.findByRole("heading", { name: /^Porty/ })).closest("div")!;
    expect(within(ports).getByText("3,6 W")).toBeInTheDocument();
  });

  it("urządzenie bez czujników nie pokazuje sekcji", async () => {
    mockApi();
    renderApp("/devices/1");
    expect(await screen.findByRole("heading", { level: 1, name: "UCG Ultra" })).toBeInTheDocument();
    await screen.findByRole("link", { name: "Port 1" });
    expect(screen.queryByRole("heading", { name: "Czujniki" })).not.toBeInTheDocument();
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
