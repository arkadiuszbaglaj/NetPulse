import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { defaultTitle, sourcePath } from "../components/widgets/chartSource";
import type { DashboardLayout } from "../lib/layout";
import { DEVICE, mockApi } from "../test/mockApi";
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
    await user.click(within(await screen.findByRole("dialog", { name: "Dodaj widget" })).getByRole("button", { name: /Wykres/ }));

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
    const chart = (state.layout as DashboardLayout).widgets.find((w) => w.type === "chart" && w.config.source.kind === "agent_container");
    expect(chart?.type === "chart" && chart.config.source).toEqual({ kind: "agent_container", id: 7, key: "nextcloud" });
    // CPU i pamięć mają różne jednostki – zostaje ostatnio wybrana
    expect(chart?.type === "chart" && chart.config.series.map((s) => s.key)).toEqual(["container_mem_bytes"]);
  });
});
