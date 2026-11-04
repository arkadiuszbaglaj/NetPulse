import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { defaultTitle, sourcePath } from "../components/widgets/chartSource";
import type { DashboardLayout } from "../lib/layout";
import { DEVICE, mockApi } from "../test/mockApi";
import { customWidgets } from "../test/addWidget";
import { renderApp } from "../test/renderApp";

const AGENT_DEVICE = { ...DEVICE, id: 7, name: "NAS", host: "nas", port: 0, driver: "agent", detected_driver: "agent", kind: "server" };

describe("wykresy z danych agenta", () => {
  it("ścieżki API i tytuły źródeł z agenta", () => {
    expect(sourcePath({ kind: "agent_net", id: 7, key: "eth0" }, 60)).toBe("/api/devices/7/agent-metrics?source=agent_net&key=eth0&minutes=60");
    expect(sourcePath({ kind: "agent_temp", id: 7, key: "coretemp/Core 0" }, 15)).toContain("key=coretemp%2FCore%200");
    expect(defaultTitle({ kind: "agent_container", id: 7, key: "nextcloud" })).toBe("Serwer z agentem: kontener Docker: nextcloud");
    expect(defaultTitle({ kind: "agent_cpu", id: 7, key: "" })).toBe("Rdzenie CPU");
  });

  it("edytor: tylko serwery z agentem i lista kontenerów z agenta", async () => {
    const { state } = mockApi({ devices: [DEVICE, AGENT_DEVICE] });
    renderApp();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edytuj pulpit" }));
    await user.click(screen.getByRole("button", { name: "Dodaj widget" }));
    await user.click(within(await customWidgets(user)).getByRole("button", { name: /^Wykres(?! kołowy)/ }));

    const form = await screen.findByRole("dialog", { name: "Nowy wykres" });
    await user.selectOptions(within(form).getByLabelText("Źródło danych"), "agent_container");
    const deviceSelect = within(form).getByLabelText("Urządzenie");
    expect(within(deviceSelect).getAllByRole("option").map((o) => o.textContent)).toEqual(["Wybierz…", "NAS"]);
    await user.selectOptions(deviceSelect, "7");
    await user.click(within(form).getByRole("button", { name: "Zapisz" }));
    expect(await within(form).findByText("Wybierz źródło danych.")).toBeInTheDocument(); // brak kontenera

    await user.selectOptions(await within(form).findByLabelText("Kontener"), "nextcloud");
    await user.click(within(form).getByLabelText("Pamięć kontenera"));
    await user.click(within(form).getByRole("button", { name: "Zapisz" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Nowy wykres" })).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Zapisz" }));

    await waitFor(() => expect(state.layout).not.toBeNull());
    const chart = (state.layout as DashboardLayout).widgets.find((w) => w.type === "chart" && w.config.queries[0].source.kind === "agent_container");
    const query = chart?.type === "chart" ? chart.config.queries[0] : null;
    expect(query?.source).toEqual({ kind: "agent_container", id: 7, key: "nextcloud" });
    // CPU i pamięć mają różne jednostki – pamięć trafia na oś prawą
    expect(query?.series.map((s) => [s.key, s.axis])).toEqual([
      ["container_cpu_percent", "left"],
      ["container_mem_bytes", "right"],
    ]);
  });

  it("edytor: czujnik SFP MikroTika – urządzenia SNMP bez serwerów z agentem", async () => {
    const mikrotik = { ...DEVICE, id: 5, name: "hEX S", driver: "auto", detected_driver: "mikrotik" };
    const { state } = mockApi({ devices: [mikrotik, AGENT_DEVICE] });
    renderApp();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edytuj pulpit" }));
    await user.click(screen.getByRole("button", { name: "Dodaj widget" }));
    await user.click(within(await customWidgets(user)).getByRole("button", { name: /^Wykres(?! kołowy)/ }));

    const form = await screen.findByRole("dialog", { name: "Nowy wykres" });
    await user.selectOptions(within(form).getByLabelText("Źródło danych"), "snmp_sfp");
    const deviceSelect = within(form).getByLabelText("Urządzenie");
    expect(within(deviceSelect).getAllByRole("option").map((o) => o.textContent)).toEqual(["Wybierz…", "hEX S"]);
    await user.selectOptions(deviceSelect, "5");
    await user.selectOptions(await within(form).findByLabelText("Port"), "sfp1");
    await user.click(within(form).getByRole("button", { name: "Zapisz" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Nowy wykres" })).not.toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Zapisz" }));

    await waitFor(() => expect(state.layout).not.toBeNull());
    const chart = (state.layout as DashboardLayout).widgets.find((w) => w.type === "chart" && w.config.queries[0].source.kind === "snmp_sfp");
    const query = chart?.type === "chart" ? chart.config.queries[0] : null;
    expect(query?.source).toEqual({ kind: "snmp_sfp", id: 5, key: "sfp1" });
    expect(query?.series.map((s) => s.key)).toEqual(["sfp_rx_dbm", "sfp_tx_dbm"]);
    expect(defaultTitle({ kind: "snmp_sfp", id: 5, key: "sfp1" })).toBe("Moduł SFP (moc optyczna, temperatura): sfp1");
  });
});
