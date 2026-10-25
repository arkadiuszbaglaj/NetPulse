import { screen, waitFor, within } from "@testing-library/react";
import { mockApi } from "../../test/mockApi";
import { renderApp } from "../../test/renderApp";

describe("Ustawienia → System", () => {
  it("pokazuje stan usług z opisami", async () => {
    mockApi();
    renderApp("/settings/system");
    await screen.findByText("API i panel"); // lista usług doczytana
    const list = screen.getByRole("region", { name: "Usługi" });
    expect(within(list).getByText("API i panel")).toBeInTheDocument();
    expect(within(list).getByText("wersja 0.8.2")).toBeInTheDocument();
    expect(within(list).getByText("PostgreSQL z TimescaleDB")).toBeInTheDocument();
    expect(within(list).getByText("Kontrolery UniFi")).toBeInTheDocument();
    expect(within(list).getByText("nieskonfigurowane")).toBeInTheDocument(); // UniFi bez kontrolera
  });

  it("nazywa usługę, która nie działa, i podaje komunikat", async () => {
    mockApi({
      services: [
        { id: "api", state: "ok", detail: "0.8.2" },
        { id: "database", state: "ok", detail: "postgres" },
        { id: "collector", state: "down", detail: "stale" },
        { id: "unifi", state: "down", detail: "Kontroler odrzucił klucz API" },
        { id: "updater", state: "down", detail: "unreachable" },
      ],
    });
    renderApp("/settings/system");
    await screen.findByText("API i panel"); // lista usług doczytana
    const list = screen.getByRole("region", { name: "Usługi" });
    expect(within(list).getAllByText("nie działa")).toHaveLength(3);
    expect(within(list).getByText(/dawno nie zapisywał danych/)).toBeInTheDocument();
    expect(within(list).getByText("Kontroler odrzucił klucz API")).toBeInTheDocument();
    expect(within(list).getByText("brak połączenia")).toBeInTheDocument();
  });

  it("pokazuje bieżący stan serwera i wykresy", async () => {
    mockApi({
      system: {
        sampled_at: "2026-10-25T10:00:00Z",
        cpu_percent: 12,
        load1: 0.1,
        load5: 0.1,
        load15: 0.1,
        mem_used_percent: 40,
        mem_total_bytes: 8_000_000_000,
        swap_used_percent: null,
        disk_used_percent: 50,
        disk_free_bytes: 100_000_000_000,
        disk_total_bytes: 200_000_000_000,
        uptime_s: 3600,
        temp_c: null,
        db_size_bytes: 1_000_000,
        poll_interval_s: 30,
      },
    });
    renderApp("/settings/system");
    expect(await screen.findByRole("meter", { name: "CPU" })).toHaveAttribute("aria-valuenow", "12");
    await waitFor(() => expect(screen.getAllByTestId("chart")).toHaveLength(4));
    expect(screen.getAllByTestId("chart")[0]).toHaveAccessibleName(/Zajętość: CPU, RAM, dysk/);
  });

  it("pokazuje błąd, gdy nie da się pobrać usług", async () => {
    mockApi({ overrides: { "GET /api/system/services": { status: 500, body: { detail: "awaria" } } } });
    renderApp("/settings/system");
    expect(await screen.findByText("Nie udało się pobrać stanu usług.")).toBeInTheDocument();
  });

  it("jest w menu Ustawień", async () => {
    mockApi();
    renderApp("/settings/system");
    expect((await screen.findAllByRole("link", { name: "System" })).length).toBeGreaterThan(0);
  });
});
