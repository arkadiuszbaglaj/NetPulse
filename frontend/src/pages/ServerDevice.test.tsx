import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ServerStatus } from "../components/widgets/ServerDetails";
import { DEVICE, mockApi } from "../test/mockApi";
import { renderApp } from "../test/renderApp";

const SERVER_DEVICE = { ...DEVICE, id: 5, name: "homelab-srv", host: "192.168.1.20", kind: "server", vendor: "Linux", model: "Linux 6.8.0-45-generic" };

const disk = (mount: string, used_percent: number) => ({
  mount,
  total_bytes: 1_000_000_000_000,
  used_bytes: used_percent * 10_000_000_000,
  used_percent,
});

const STATUS: ServerStatus = {
  sampled_at: "2026-10-25T10:00:00Z",
  cpu_percent: 13,
  mem_used_percent: 35,
  swap_used_percent: 25,
  load1: 0.52,
  uptime_s: 90_000,
  processes: 213,
  disks: [disk("/", 35), disk("/mnt/data", 90), disk("/boot", 25), disk("/mnt/a", 10), disk("/mnt/b", 5), disk("/mnt/c", 1)],
};

describe("karta serwera Linux", () => {
  it("pokazuje CPU, RAM, swap i najbardziej zapełnione dyski", async () => {
    mockApi({ devices: [SERVER_DEVICE], server: STATUS });
    renderApp();
    expect(await screen.findByRole("meter", { name: "CPU" })).toHaveAttribute("aria-valuenow", "13");
    expect(screen.getByRole("meter", { name: "RAM" })).toHaveAttribute("aria-valuenow", "35");
    expect(screen.getByRole("meter", { name: "Swap" })).toHaveAttribute("aria-valuenow", "25");
    const meters = screen.getAllByRole("meter").map((m) => m.getAttribute("aria-label"));
    expect(meters.slice(3)).toEqual(["/mnt/data", "/", "/boot", "/mnt/a"]); // od najbardziej zapełnionego, max 4
    expect(screen.getByText("…i 2 więcej")).toBeInTheDocument();
    expect(screen.getByText("procesów: 213", { exact: false })).toBeInTheDocument();
  });

  it("nie pokazuje pasków dla urządzeń sieciowych ani gdy brak danych", async () => {
    mockApi({ devices: [DEVICE] });
    renderApp();
    await screen.findByText("UCG Ultra");
    expect(screen.queryByRole("meter")).not.toBeInTheDocument();
  });

  it("serwer bez próbki pokazuje samą kartę urządzenia", async () => {
    mockApi({ devices: [SERVER_DEVICE], server: null });
    renderApp();
    expect(await screen.findByText("homelab-srv")).toBeInTheDocument();
    expect(screen.getByText(/192.168.1.20 · Serwer/)).toBeInTheDocument();
    expect(screen.queryByRole("meter")).not.toBeInTheDocument();
  });
});

describe("dodawanie serwera Linux", () => {
  it("wybór sterownika Serwer Linux pokazuje podpowiedź o snmpd", async () => {
    mockApi();
    renderApp("/settings/devices");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Dodaj urządzenie/ }));
    const dialog = await screen.findByRole("dialog");
    await user.selectOptions(within(dialog).getByLabelText("Sterownik"), "linux");
    expect(within(dialog).getByText(/apt install snmpd/)).toBeInTheDocument();
  });
});
