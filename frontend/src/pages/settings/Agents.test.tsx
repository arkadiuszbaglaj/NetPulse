import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentInfo, ServerStatus } from "../../components/widgets/ServerDetails";
import { installCommand, uninstallCommand, updateCommand } from "../../lib/agents";
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

  it("agent starszy niż NetPulse: ostrzeżenie na karcie", async () => {
    mockApi({
      devices: [AGENT_DEVICE],
      server: status({ ...base, temps: [], services: null, containers: null, smart: null, outdated: true, server_version: "0.24.0" }),
    });
    renderApp();
    const list = await screen.findByRole("list", { name: "Stan z agenta" });
    expect(within(list).getByText("Agent 0.11.0 jest starszy niż NetPulse – zaktualizuj go")).toHaveClass("text-warning");
  });
});

describe("strona szczegółów serwera", () => {
  const status = (agent: AgentInfo | null): ServerStatus => ({
    sampled_at: "2026-10-25T10:00:00Z",
    cpu_percent: 20,
    mem_used_percent: 40,
    swap_used_percent: null,
    load1: 0.2,
    uptime_s: 3600,
    processes: 120,
    disks: [
      { mount: "/", total_bytes: 100e9, used_bytes: 30e9, used_percent: 30 },
      { mount: "/mnt/data", total_bytes: 4e12, used_bytes: 3.6e12, used_percent: 90 },
    ],
    agent,
  });
  const agent: AgentInfo = {
    agent_version: "0.11.0",
    os: "Ubuntu 24.04",
    kernel: "6.8.0-45-generic",
    cpu_cores: 4,
    load: [0.2, 0.15, 0.1],
    mem_total_bytes: 8e9,
    disk_io: [{ device: "sda", read_bps: 2_000_000, write_bps: 0 }],
    net: [{ iface: "eth0", rx_bps: 8_000_000, tx_bps: 1_000_000 }],
    temps: [{ sensor: "coretemp/Core 0", celsius: 47.6 }, { sensor: "nvme/Composite", celsius: 90 }],
    services: { running: 25, failed: 1, items: [{ name: "nginx.service", active: "active", sub: "running" }, { name: "backup.service", active: "failed", sub: "failed" }] },
    containers: [
      { name: "nextcloud", image: "nextcloud:29", state: "running", status: "Up 2 days", cpu_percent: 1.5, mem_bytes: 5e8 },
      { name: "old-app", image: "x", state: "exited", status: "Exited (1)", cpu_percent: null, mem_bytes: null },
    ],
    smart: [{ device: "sda", model: "WDC WD40", passed: true, temp_c: 33, power_on_hours: 12000, reallocated: 0 }],
    outdated: true,
    server_version: "0.24.0",
  };

  it("strona urządzenia prowadzi do pełnych szczegółów: dyski, kontenery, usługi, sieć, temperatury", async () => {
    mockApi({ devices: [AGENT_DEVICE], server: status(agent) });
    renderApp("/devices/7");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("link", { name: "Wszystkie szczegóły serwera" }));

    expect(await screen.findByRole("heading", { level: 1, name: "NAS · szczegóły serwera" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/devices/7/server");
    expect(screen.getByText("Ubuntu 24.04")).toBeInTheDocument();
    expect(screen.getByText("0,20 / 0,15 / 0,10")).toBeInTheDocument();
    // Systemy plików: wszystkie, nie tylko 4 jak na karcie
    expect(screen.getByRole("meter", { name: "/mnt/data" })).toHaveAttribute("aria-valuenow", "90");
    expect(screen.getByText("Dyski (1)")).toBeInTheDocument();
    expect(screen.getByText("WDC WD40")).toBeInTheDocument();
    expect(screen.getByText("Kontenery Docker (1 z 2 działa)")).toBeInTheDocument();
    // Zatrzymany kontener i usługa z błędem na górze tabel
    const containers = screen.getByText("Kontenery Docker (1 z 2 działa)").closest("div")!;
    expect(within(containers).getAllByRole("row")[1]).toHaveTextContent("old-app");
    const services = screen.getByText("Usługi systemd").closest("div")!;
    expect(within(services).getAllByRole("row")[1]).toHaveTextContent("backup");
    expect(screen.getByText("eth0")).toBeInTheDocument();
    expect(screen.getByText("90°C")).toHaveClass("text-danger");
    // Agent starszy niż NetPulse: polecenie aktualizacji
    const note = screen.getByText("Agent 0.11.0 jest starszy niż NetPulse 0.24.0").closest("div")!;
    expect(within(note).getByText(updateCommand(window.location.origin))).toBeInTheDocument();
  });

  it("serwer bez świeżych danych: komunikat", async () => {
    mockApi({ devices: [AGENT_DEVICE], server: null });
    renderApp("/devices/7/server");
    expect(await screen.findByText("Serwer nie przysłał danych w ostatnich 5 minutach.")).toBeInTheDocument();
  });

  it("Ustawienia → Agenci: plakietka i polecenie aktualizacji dla starszych agentów", async () => {
    mockApi({ agents: [{ ...AGENT, outdated: true }, { ...AGENT, id: 2, device_id: 8, name: "Backup", agent_version: "0.24.0" }] });
    renderApp("/settings/agents");
    expect(await screen.findAllByText("do aktualizacji")).toHaveLength(1);
    expect(screen.getByText("Agenci do aktualizacji: NAS")).toBeInTheDocument();
    expect(screen.getByLabelText("Polecenie aktualizacji")).toHaveTextContent(updateCommand(window.location.origin));
  });
});
