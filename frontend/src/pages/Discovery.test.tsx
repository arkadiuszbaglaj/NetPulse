import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  createFromFound,
  issueLink,
  partiallyKnown,
  preselected,
  readableValue,
  reportFile,
  sortFound,
  type DeviceReport,
  type FoundDevice,
} from "../lib/discovery";
import { mockApi } from "../test/mockApi";
import { renderApp } from "../test/renderApp";

const found = (over: Partial<FoundDevice>): FoundDevice => ({
  host: "192.168.1.9",
  name: null,
  suggested_name: "Urządzenie",
  descr: null,
  object_id: null,
  vendor: null,
  model: null,
  firmware: null,
  kind: "other",
  driver: "generic",
  generic: true,
  device_id: null,
  ...over,
});

const GW = found({ host: "192.168.1.1", name: "UCG-Ultra", suggested_name: "UCG-Ultra", vendor: "Ubiquiti", model: "UCG-Ultra", firmware: "6.0.17", kind: "gateway", driver: "unifi", generic: false });
const SW = found({ host: "192.168.1.2", name: "USW-Switch", suggested_name: "USW-Switch", vendor: "Ubiquiti", model: "UniFi Switch", kind: "switch", driver: "unifi", generic: false });
const AP = found({ host: "192.168.1.3", name: "APU6-Plus", suggested_name: "APU6-Plus", vendor: "Ubiquiti", model: "U6+", kind: "ap", driver: "unifi", generic: false });
const PRINTER = found({ host: "192.168.1.40", name: "drukarka", suggested_name: "drukarka", descr: "Printer 3000", vendor: "Generic", model: "Printer" });

const REPORT: DeviceReport = {
  format: "netpulse-device-report",
  format_version: 1,
  netpulse: "0.73.0",
  created_at: "2026-11-13T10:00:00+00:00",
  interval_s: 30,
  device: { sys_object_id: "1.3.6.1.4.1.99999.1", sys_descr: "Printer 3000", detected_driver: "generic", driver: "generic", uptime_s: 100 },
  branches: [
    { oid: "1.3.6.1.2.1.1", name: "SNMPv2-MIB::system", records: 2, truncated: false },
    { oid: "1.3.6.1.2.1.105.1", name: "POWER-ETHERNET-MIB", records: 0, truncated: false, error: "timeout" },
  ],
  records: 2,
  changed: 0,
  walk: "1.3.6.1.2.1.1.1.0|4x|5072696e7465722033303030\n1.3.6.1.2.1.1.5.0|4x|646576696365\n",
  walk2_changes: "",
  notes: "",
};

describe("wykrywanie – logika", () => {
  it("zaznacza od razu tylko nowy sprzęt sieciowy i układa router, switch, AP, resztę", () => {
    expect(preselected(GW)).toBe(true);
    expect(preselected(PRINTER)).toBe(false);
    expect(preselected({ ...SW, device_id: 3 })).toBe(false);
    expect(sortFound([PRINTER, AP, SW, GW]).map((f) => f.host)).toEqual(["192.168.1.1", "192.168.1.2", "192.168.1.3", "192.168.1.40"]);
  });

  it("nowe urządzenie z wyniku skanu ma dane SNMP skanu i automatyczny driver", () => {
    expect(createFromFound(AP, " Salon ", { port: 161, snmp_version: "2c", community: "tajne" })).toEqual({
      name: "Salon",
      host: "192.168.1.3",
      driver: "auto",
      port: 161,
      snmp_version: "2c",
      community: "tajne",
    });
    expect(createFromFound(AP, "", { port: 161, snmp_version: "2c", community: "public" }).name).toBe("APU6-Plus");
  });

  it("raport: plik z uwagami, link do zgłoszenia i czytelne wartości", () => {
    const f = reportFile(REPORT, " port 5 to WAN ");
    expect(f.name).toBe("uplinkview-report-1.3.6.1.4.1.99999.1-2026-11-13.json");
    expect(JSON.parse(f.text).notes).toBe("port 5 to WAN");
    const url = new URL(issueLink(REPORT, "Printer 3000 v2", "uwagi"));
    expect(url.origin + url.pathname).toBe("https://github.com/uplinkview/uplinkview/issues/new");
    expect(url.searchParams.get("template")).toBe("nowe-urzadzenie.yml");
    expect(url.searchParams.get("title")).toBe("Nowe urządzenie: Printer 3000 v2");
    expect(url.searchParams.get("object_id")).toBe("1.3.6.1.4.1.99999.1");
    expect(readableValue("4x", "646576696365")).toBe('"device"');
    expect(readableValue("4x", "02aabb")).toBe("0x02aabb");
    expect(readableValue("70", "123")).toBe("123");
    expect(partiallyKnown("generic")).toBe(true);
    expect(partiallyKnown("unifi")).toBe(false);
  });
});

describe("wykrywanie w kreatorze (0.73.0)", () => {
  it("skan podsieci, zaznaczone urządzenia sieciowe i dodanie jednym kliknięciem", async () => {
    const { state, calls } = mockApi({ devices: [] });
    state.overrides["POST /api/discovery/scan"] = { status: 200, body: { network: "192.168.1.0/24", scanned: 254, took_s: 4.4, found: [PRINTER, AP, GW, SW] } };
    renderApp("/setup");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Zaczynamy" }));
    const network = screen.getByLabelText("Podsieć");
    await waitFor(() => expect(network).toHaveValue("192.168.1.0/24")); // podpowiedź z API
    await user.click(screen.getByRole("button", { name: "Szukaj urządzeń" }));

    const list = await screen.findByRole("list", { name: "Znalezione urządzenia" });
    expect(screen.getByText("Znalezione: 4 z 254 adresów, 4,4 s.")).toBeInTheDocument();
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((r) => within(r).getByRole("checkbox").getAttribute("aria-label"))).toEqual([
      "Dodaj 192.168.1.1",
      "Dodaj 192.168.1.2",
      "Dodaj 192.168.1.3",
      "Dodaj 192.168.1.40",
    ]);
    expect(screen.getByRole("checkbox", { name: "Dodaj 192.168.1.40" })).not.toBeChecked(); // drukarka – tylko na życzenie
    expect(within(rows[3]).getByText("podstawowa obsługa")).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/api/discovery/scan")?.body).toEqual({ network: "192.168.1.0/24", port: 161, snmp_version: "2c", community: "public" });

    await user.click(screen.getByRole("checkbox", { name: "Dodaj 192.168.1.2" })); // switch zostaje
    const apName = screen.getByLabelText("Nazwa urządzenia 192.168.1.3");
    await user.clear(apName);
    await user.type(apName, "AP salon");
    await user.click(screen.getByRole("button", { name: "Dodaj zaznaczone (2)" }));

    await waitFor(() => expect(state.devices.map((d) => [d.host, d.name])).toEqual([["192.168.1.1", "UCG-Ultra"], ["192.168.1.3", "AP salon"]]));
    expect(await screen.findByText(/Dodano: UCG-Ultra, AP salon/)).toBeInTheDocument();
    expect(within(list).getAllByText("dodane")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Dodaj zaznaczone (0)" })).toBeDisabled();
  });

  it("urządzenie już dodane jest oznaczone i nie da się go zaznaczyć", async () => {
    const { state } = mockApi();
    state.overrides["POST /api/discovery/scan"] = { status: 200, body: { network: "192.168.1.0/24", scanned: 254, took_s: 4.1, found: [{ ...GW, device_id: 1 }] } };
    renderApp("/settings/devices");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Wykryj w sieci" }));
    await waitFor(() => expect(screen.getByLabelText("Podsieć")).toHaveValue("192.168.1.0/24"));
    await user.click(screen.getByRole("button", { name: "Szukaj urządzeń" }));
    expect(await screen.findByText("już w UplinkView")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Dodaj 192.168.1.1" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Dodaj zaznaczone/ })).not.toBeInTheDocument();
  });

  it("pusty wynik podpowiada, co sprawdzić", async () => {
    mockApi({ devices: [] });
    renderApp("/settings/devices"); // bez urządzeń wykrywanie jest od razu widoczne
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByLabelText("Podsieć")).toHaveValue("192.168.1.0/24"));
    await user.click(screen.getByRole("button", { name: "Szukaj urządzeń" }));
    expect(await screen.findByText(/Nic nie odpowiedziało na SNMP/)).toBeInTheDocument();
  });
});

describe("raport urządzenia (0.73.0)", () => {
  it("urządzenie znane tylko ogólnie: zachęta, raport z podglądem i link do zgłoszenia", async () => {
    const { state, calls } = mockApi();
    state.devices[0] = { ...state.devices[0], detected_driver: "generic", model: "Printer" };
    state.overrides[`POST /api/devices/${state.devices[0].id}/report`] = { status: 200, body: REPORT };
    renderApp(`/devices/${state.devices[0].id}`);
    const user = userEvent.setup();
    expect(await screen.findByText("UplinkView zna to urządzenie tylko częściowo")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Przygotuj raport" }));
    expect(await screen.findByText("Podgląd: 2 wartości, 0 zmienionych w drugim odczycie")).toBeInTheDocument();
    expect(calls.some((c) => c.method === "POST" && c.path === `/api/devices/${state.devices[0].id}/report?interval=30`)).toBe(true);
    expect(screen.getByLabelText("Zrzut SNMP po anonimizacji").textContent).toContain('1.3.6.1.2.1.1.5.0 = "device"');
    expect(screen.getByRole("button", { name: "Pobierz raport" })).toBeInTheDocument();
    const issue = screen.getByRole("link", { name: "Zgłoś na GitHubie" });
    expect(new URL(issue.getAttribute("href")!).searchParams.get("title")).toBe("Nowe urządzenie: Printer");
  });

  it("dobrze znane urządzenie: raport tylko na życzenie", async () => {
    const { state } = mockApi();
    state.devices[0] = { ...state.devices[0], detected_driver: "unifi" };
    renderApp(`/devices/${state.devices[0].id}`);
    const user = userEvent.setup();
    const open = await screen.findByRole("button", { name: "Przygotuj raport urządzenia dla twórców UplinkView" });
    expect(screen.queryByText("UplinkView zna to urządzenie tylko częściowo")).not.toBeInTheDocument();
    await user.click(open);
    expect(screen.getByRole("heading", { name: "Raport urządzenia" })).toBeInTheDocument();
  });
});
