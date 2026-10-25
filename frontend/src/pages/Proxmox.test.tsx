import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ServerStatus } from "../components/widgets/ServerDetails";
import type { ProxmoxGuest, ProxmoxStorage } from "../lib/proxmox";
import { DEVICE, PVE_SERVER, mockApi } from "../test/mockApi";
import { renderApp } from "../test/renderApp";

const GiB = 1024 ** 3;
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

const guest = (over: Partial<ProxmoxGuest>): ProxmoxGuest => ({
  server_id: 1,
  server: "Homelab",
  vmid: 100,
  node: "pve1",
  device_id: 8,
  type: "qemu",
  name: "homeassistant",
  key: "homeassistant (100)",
  status: "running",
  template: false,
  tags: null,
  cpus: 2,
  cpu_percent: 25,
  mem_used: 2 * GiB,
  mem_total: 4 * GiB,
  disk_used: null,
  disk_total: 32 * GiB,
  uptime_s: 3600,
  last_backup_at: hoursAgo(2),
  updated_at: new Date().toISOString(),
  ...over,
});

const GUESTS = [
  guest({}),
  guest({ vmid: 101, name: "windows", key: "windows (101)", status: "stopped", cpu_percent: null, mem_used: null, uptime_s: null, last_backup_at: null }),
  guest({ vmid: 106, type: "lxc", name: "pihole", key: "pihole (106)", node: "pve2", device_id: 9, last_backup_at: hoursAgo(72), tags: "dns;prod" }),
  guest({ vmid: 9000, name: "ubuntu-template", key: "ubuntu-template (9000)", status: "stopped", template: true, last_backup_at: null }),
];
const STORAGES: ProxmoxStorage[] = [
  { server_id: 1, node: "pve1", storage: "local-lvm", type: "lvmthin", shared: false, active: true, content: "images,rootdir", used_bytes: 300 * GiB, total_bytes: 400 * GiB, updated_at: "" },
  { server_id: 1, node: "pve1", storage: "nas-backup", type: "nfs", shared: true, active: true, content: "backup", used_bytes: 950 * GiB, total_bytes: 1000 * GiB, updated_at: "" },
];
const NODE_DEVICE = { ...DEVICE, id: 8, name: "pve1", host: "192.168.1.10", port: 0, driver: "proxmox", detected_driver: "proxmox", kind: "server" };

describe("Ustawienia → Proxmox", () => {
  it("dodaje serwer: sprawdza format tokenu, testuje połączenie i nie wysyła sekretu z powrotem", async () => {
    const { state, calls } = mockApi();
    renderApp("/settings/proxmox");
    const user = userEvent.setup();
    expect(await screen.findByText("Nie dodano jeszcze serwera Proxmox")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Dodaj serwer Proxmox" }));
    const form = await screen.findByRole("dialog", { name: "Nowy serwer Proxmox" });
    await user.type(within(form).getByLabelText("Nazwa"), "Homelab");
    await user.type(within(form).getByLabelText(/Adres/), "192.168.1.10");
    await user.type(within(form).getByLabelText("Identyfikator tokenu"), "netpulse");
    await user.type(within(form).getByLabelText("Sekret tokenu"), "aaaa-bbbb-cccc");
    await user.click(within(form).getByRole("button", { name: "Zapisz" }));
    expect(await within(form).findByText(/użytkownik@realm!id/)).toBeInTheDocument();

    await user.clear(within(form).getByLabelText("Identyfikator tokenu"));
    await user.type(within(form).getByLabelText("Identyfikator tokenu"), "netpulse@pve!monitor");
    await user.click(within(form).getByRole("button", { name: /Testuj/ }));
    expect(await within(form).findByText(/Proxmox VE 8.2.4, klaster homelab, węzłów: 2/)).toBeInTheDocument();
    await user.click(within(form).getByRole("button", { name: "Zapisz" }));
    await waitFor(() => expect(state.pveServers).toHaveLength(1));
    const sent = calls.find((c) => c.method === "POST" && c.path.startsWith("/api/proxmox/servers"))?.body as Record<string, unknown>;
    expect(sent).toMatchObject({ name: "Homelab", host: "192.168.1.10", port: 8006, token_id: "netpulse@pve!monitor", token_secret: "aaaa-bbbb-cccc" });
    expect(await screen.findByText("Homelab")).toBeInTheDocument();
  });

  it("lista serwerów: wersja, klaster i błąd połączenia", async () => {
    mockApi({ pveServers: [{ ...PVE_SERVER, status: "down", last_error: "Proxmox odrzucił token API" }] });
    renderApp("/settings/proxmox");
    expect(await screen.findByText(/192.168.1.10:8006 · Proxmox VE 8.2.4 · klaster homelab/)).toBeInTheDocument();
    expect(screen.getByText("Proxmox odrzucił token API")).toBeInTheDocument();
  });
});

describe("strona Proxmox", () => {
  it("bez serwera podpowiada, gdzie go dodać", async () => {
    mockApi();
    renderApp("/proxmox");
    expect(await screen.findByText("Brak serwera Proxmox")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Proxmox VE" })).toHaveAttribute("href", "/settings/proxmox");
  });

  it("maszyny ze stanem, pamięcią i wiekiem kopii; magazyny z paskami", async () => {
    mockApi({ pveServers: [PVE_SERVER], pveGuests: GUESTS, pveStorages: STORAGES });
    renderApp("/proxmox");
    expect(await screen.findByRole("heading", { name: "Maszyny VM i kontenery LXC (2 z 3 działa)" })).toBeInTheDocument();
    const row = (name: string) => screen.getByText(name).closest("tr") as HTMLElement;
    expect(within(row("homeassistant")).getByText("działa")).toBeInTheDocument();
    expect(within(row("homeassistant")).getByText(/2(,\d+)? GB \/ 4(,\d+)? GB/)).toBeInTheDocument();
    expect(within(row("windows")).getByText("zatrzymana")).toBeInTheDocument();
    expect(within(row("windows")).getByText("brak kopii")).toBeInTheDocument();
    expect(within(row("pihole")).getByText(/LXC 106 · pve2 · dns, prod/)).toBeInTheDocument();
    expect(within(row("pihole")).getByText(/temu/)).toHaveClass("text-danger"); // kopia sprzed 3 dni
    expect(within(row("ubuntu-template")).getByText("szablon")).toBeInTheDocument();
    expect(screen.getByRole("meter", { name: "nas-backup · współdzielony" })).toHaveAttribute("aria-valuenow", "95");
    expect(screen.getByRole("meter", { name: "local-lvm · pve1" })).toHaveAttribute("aria-valuenow", "75");
  });

  it("karta węzła na pulpicie: maszyny i błąd kopii zapasowej", async () => {
    const status: ServerStatus = {
      sampled_at: new Date().toISOString(),
      cpu_percent: 12,
      mem_used_percent: 25,
      swap_used_percent: null,
      load1: 0.52,
      uptime_s: 864000,
      processes: null,
      disks: [{ mount: "local-lvm (lvmthin)", total_bytes: 400 * GiB, used_bytes: 300 * GiB, used_percent: 75 }],
      proxmox: { version: "8.2.4", cluster: "homelab", guests_running: 2, guests_total: 3, backup_status: "job errors", backup_at: hoursAgo(2) },
    };
    mockApi({ devices: [NODE_DEVICE], server: status });
    renderApp();
    const list = await screen.findByRole("list", { name: "Stan z Proxmox" });
    expect(within(list).getByText("VM/LXC: 2 z 3 działa")).toBeInTheDocument();
    expect(within(list).getByText("Kopia zapasowa z błędem: job errors")).toHaveClass("text-danger");
    expect(screen.getByRole("meter", { name: "local-lvm (lvmthin)" })).toBeInTheDocument();
  });

  it("w Urządzeniach węzeł Proxmox nie ma testu SNMP ani edycji", async () => {
    mockApi({ devices: [NODE_DEVICE] });
    renderApp("/settings/devices");
    expect(await screen.findByText(/192.168.1.10 · Serwer · węzeł Proxmox VE/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edytuj pve1" })).not.toBeInTheDocument();
  });

  it("reguła alertu: maszyna zatrzymana z filtrem nazwy", async () => {
    const { state } = mockApi();
    renderApp("/settings/alert-rules");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Dodaj regułę" }));
    const form = await screen.findByRole("dialog", { name: "Nowa reguła" });
    await user.type(within(form).getByLabelText("Nazwa"), "Home Assistant");
    await user.selectOptions(within(form).getByLabelText("Rodzaj reguły"), "guest_stopped");
    expect(within(form).getByText(/Dane czyta NetPulse z Proxmox VE/)).toBeInTheDocument();
    await user.type(within(form).getByLabelText("Tylko o nazwie (opcjonalnie)"), "homeassistant*");
    await user.click(within(form).getByRole("button", { name: "Zapisz" }));
    await waitFor(() => expect(state.rules[0]).toMatchObject({ kind: "guest_stopped", match: "homeassistant*" }));
  });

  it("edytor wykresu: maszyny Proxmox tylko z węzłów Proxmox", async () => {
    mockApi({ devices: [DEVICE, NODE_DEVICE] });
    renderApp();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edytuj pulpit" }));
    await user.click(screen.getByRole("button", { name: "Dodaj widget" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Dodaj widget" })).getByRole("button", { name: /Wykres/ }));
    const form = await screen.findByRole("dialog", { name: "Nowy wykres" });
    await user.selectOptions(within(form).getByLabelText("Źródło danych"), "pve_guest");
    const devices = within(form).getByLabelText("Urządzenie");
    expect(within(devices).getAllByRole("option").map((o) => o.textContent)).toEqual(["Wybierz…", "pve1"]);
    await user.selectOptions(devices, "8");
    expect(within(await within(form).findByLabelText("Maszyna")).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Wybierz…",
      "homeassistant (100)",
      "nextcloud (105)",
    ]);
  });
});
