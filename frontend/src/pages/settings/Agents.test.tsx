import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ServerStatus } from "../../components/widgets/ServerDetails";
import { installCommand, uninstallCommand } from "../../lib/agents";
import { AGENT, DEVICE, mockApi } from "../../test/mockApi";
import { renderApp } from "../../test/renderApp";

const AGENT_DEVICE = { ...DEVICE, id: 7, name: "NAS", host: "nas", port: 0, driver: "agent", detected_driver: "agent", kind: "server" };

describe("Ustawienia → Agenci", () => {
  it("pusty stan zachęca do dodania serwera", async () => {
    mockApi();
    renderApp("/settings/agents");
    expect(await screen.findByRole("heading", { name: "Agenci serwerów Linux" })).toBeInTheDocument();
    expect(await screen.findByText("Nie dodano jeszcze serwera z agentem")).toBeInTheDocument();
  });

  it("dodanie serwera pokazuje polecenie instalacji z tokenem (raz)", async () => {
    const { calls } = mockApi();
    renderApp("/settings/agents");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Dodaj serwer z agentem" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Utwórz token" }));
    expect(within(dialog).getByText("Podaj nazwę.")).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Nazwa"), "Serwer plików");
    await user.click(within(dialog).getByRole("button", { name: "Utwórz token" }));

    const tokenDialog = await screen.findByRole("dialog", { name: "Instalacja agenta: Serwer plików" });
    const command = within(tokenDialog).getByLabelText("Polecenie instalacji");
    expect(command).toHaveTextContent(installCommand(window.location.origin, "npa_test1tokenXyZ9"));
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/agents")).toBe(true);
    await user.click(within(tokenDialog).getByRole("button", { name: "Gotowe" }));
    // Lista: nowy serwer czeka na pierwszy raport
    expect(await screen.findByText("Serwer plików")).toBeInTheDocument();
    expect(screen.getByText("czeka na agenta")).toBeInTheDocument();
    expect(screen.queryByText(/npa_test1tokenXyZ9/)).not.toBeInTheDocument();
  });

  it("lista pokazuje stan, a nowy token wymaga potwierdzenia", async () => {
    mockApi({ agents: [{ ...AGENT }] });
    renderApp("/settings/agents");
    const user = userEvent.setup();
    expect(await screen.findByText(/nas · agent 0.11.0 · raport .* · token …Ab3x/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Nowy token: NAS" }));
    const confirm = await screen.findByRole("dialog", { name: "Wygenerować nowy token?" });
    await user.click(within(confirm).getByRole("button", { name: "Nowy token" }));
    const shown = await screen.findByRole("dialog", { name: "Instalacja agenta: NAS" });
    expect(within(shown).getByLabelText("Polecenie instalacji")).toHaveTextContent("npa_rotated1NeW1");
  });

  it("usunięcie serwera podpowiada, jak odinstalować agenta", async () => {
    const { state } = mockApi({ agents: [{ ...AGENT }], devices: [AGENT_DEVICE] });
    renderApp("/settings/agents");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Usuń NAS" }));
    const dialog = await screen.findByRole("dialog", { name: "Usunąć serwer z agentem?" });
    expect(within(dialog).getByText(uninstallCommand(window.location.origin))).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Usuń" }));
    await waitFor(() => expect(state.agents).toEqual([]));
    expect(await screen.findByText("Nie dodano jeszcze serwera z agentem")).toBeInTheDocument();
  });

  it("w Urządzeniach serwer z agentem nie ma testu SNMP ani edycji", async () => {
    mockApi({ devices: [AGENT_DEVICE, DEVICE] });
    renderApp("/settings/devices");
    expect(await screen.findByText(/nas · Serwer · agent NetPulse/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edytuj NAS" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Testuj.* NAS/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edytuj UCG Ultra" })).toBeInTheDocument();
  });
});

describe("karta serwera z agentem", () => {
  const status = (agent: ServerStatus["agent"]): ServerStatus => ({
    sampled_at: "2026-10-25T10:00:00Z",
    cpu_percent: 10,
    mem_used_percent: 30,
    swap_used_percent: null,
    load1: 0.2,
    uptime_s: 3600,
    processes: 120,
    disks: [],
    agent,
  });
  const base = { agent_version: "0.11.0", os: "Ubuntu 24.04", kernel: "6.8", cpu_cores: 4, load: [0.2, 0.1, 0.1], mem_total_bytes: 8e9 };

  it("pokazuje kontenery, usługi, temperaturę i SMART; problemy osobno", async () => {
    mockApi({
      devices: [AGENT_DEVICE],
      server: status({
        ...base,
        temps: [{ sensor: "coretemp/Core 0", celsius: 47.6 }, { sensor: "nvme/Composite", celsius: 39 }],
        services: { running: 25, failed: 1, items: [{ name: "backup.service", active: "failed", sub: "failed" }] },
        containers: [
          { name: "nextcloud", image: "nextcloud", state: "running", status: "Up 2 days", cpu_percent: 1, mem_bytes: 1e8 },
          { name: "db", image: "postgres", state: "running", status: "Up 2 days", cpu_percent: 1, mem_bytes: 1e8 },
          { name: "old-app", image: "x", state: "exited", status: "Exited (1)", cpu_percent: null, mem_bytes: null },
        ],
        smart: [{ device: "sda", model: "WDC", passed: true, temp_c: 33 }],
      }),
    });
    renderApp();
    const list = await screen.findByRole("list", { name: "Stan z agenta" });
    expect(within(list).getByText("Kontenery: 2 z 3 działa")).toBeInTheDocument();
    expect(within(list).getByText("Zatrzymane: old-app")).toHaveClass("text-danger");
    expect(within(list).getByText("Usługi z problemem: backup")).toHaveClass("text-danger");
    expect(within(list).getByText("Temperatura: 48°C")).not.toHaveClass("text-danger");
    expect(within(list).getByText("SMART: dyski w porządku (1)")).toBeInTheDocument();
  });

  it("bez Dockera i SMART pokazuje tylko to, co jest", async () => {
    mockApi({
      devices: [AGENT_DEVICE],
      server: status({ ...base, temps: [], services: { running: 12, failed: 0, items: [] }, containers: null, smart: null }),
    });
    renderApp();
    const list = await screen.findByRole("list", { name: "Stan z agenta" });
    expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Usługi: 12 działa, bez błędów"]);
  });
});
