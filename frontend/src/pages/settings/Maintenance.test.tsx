import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DEVICE, mockApi } from "../../test/mockApi";
import { renderApp } from "../../test/renderApp";
import type { MaintenanceWindow } from "../../lib/maintenance";

const WEEKLY: MaintenanceWindow = {
  id: 1,
  name: "Nocny restart",
  enabled: true,
  device_ids: [1],
  kind: "weekly",
  starts_at: null,
  ends_at: null,
  days: [5, 6],
  time_from: "02:00",
  duration_min: 90,
  note: null,
  created_at: "2026-11-01T10:00:00Z",
  active: true,
  active_until: "2026-11-07T01:30:00Z",
  next_start: "2026-11-08T01:00:00Z",
};

async function openPage(maintenance: MaintenanceWindow[] = []) {
  const user = userEvent.setup();
  const api = mockApi({ maintenance });
  renderApp("/settings/maintenance");
  await screen.findByRole("heading", { name: "Okna serwisowe" });
  return { user, ...api };
}

const lastCall = (calls: { method: string; path: string; body: unknown }[], method: string, path: string) =>
  [...calls].reverse().find((c) => c.method === method && c.path === path);

describe("okna serwisowe", () => {
  it("lista pokazuje harmonogram, urządzenia i trwające okno", async () => {
    await openPage([WEEKLY]);
    const row = (await screen.findByText("Nocny restart")).closest("li") as HTMLElement;
    expect(within(row).getByText("sob., niedz. od 02:00 przez 1 h 30 min")).toBeInTheDocument();
    expect(within(row).getByText(DEVICE.name)).toBeInTheDocument();
    expect(within(row).getByText(/^trwa do /)).toBeInTheDocument();
  });

  it("pusta lista zaprasza do dodania okna", async () => {
    await openPage();
    expect(await screen.findByText("Brak okien serwisowych")).toBeInTheDocument();
  });

  it("dodaje okno jednorazowe na wszystkie urządzenia", async () => {
    const { user, calls } = await openPage();
    await user.click(screen.getByRole("button", { name: "Dodaj okno" }));
    const dialog = await screen.findByRole("dialog", { name: "Nowe okno serwisowe" });
    await user.click(within(dialog).getByRole("button", { name: "Zapisz" }));
    expect(within(dialog).getByText("Podaj nazwę okna")).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText("Nazwa"), "Firmware switcha");
    const starts = within(dialog).getByLabelText("Początek");
    const ends = within(dialog).getByLabelText("Koniec");
    await user.clear(starts);
    await user.type(starts, "2026-11-10T22:00");
    await user.clear(ends);
    await user.type(ends, "2026-11-10T21:00");
    await user.click(within(dialog).getByRole("button", { name: "Zapisz" }));
    expect(within(dialog).getByText("Koniec musi być po początku")).toBeInTheDocument();

    await user.clear(ends);
    await user.type(ends, "2026-11-10T23:30");
    await user.click(within(dialog).getByRole("button", { name: "Zapisz" }));
    const body = lastCall(calls, "POST", "/api/maintenance")?.body as Record<string, unknown>;
    expect(body).toMatchObject({ name: "Firmware switcha", kind: "once", device_ids: [], days: [], time_from: null, duration_min: null });
    expect(new Date(body.ends_at as string).getTime() - new Date(body.starts_at as string).getTime()).toBe(90 * 60_000);
    expect(await screen.findByText("Firmware switcha")).toBeInTheDocument();
  });

  it("okno cotygodniowe dla wybranego urządzenia", async () => {
    const { user, calls } = await openPage();
    await user.click(screen.getByRole("button", { name: "Dodaj okno" }));
    const dialog = await screen.findByRole("dialog", { name: "Nowe okno serwisowe" });
    await user.type(within(dialog).getByLabelText("Nazwa"), "Restart AP");
    await user.click(within(dialog).getByLabelText("Co tydzień"));
    await user.click(within(dialog).getByLabelText("pon."));
    await user.click(within(dialog).getByLabelText(/^Wszystkie urządzenia/));
    await user.click(within(dialog).getByRole("button", { name: "Zapisz" }));
    expect(within(dialog).getByText("Wybierz co najmniej jedno urządzenie")).toBeInTheDocument();
    await user.click(within(dialog).getByLabelText(new RegExp(DEVICE.name)));
    await user.click(within(dialog).getByRole("button", { name: "Zapisz" }));
    expect(lastCall(calls, "POST", "/api/maintenance")?.body).toMatchObject({
      kind: "weekly",
      days: [0, 5],
      time_from: "02:00",
      duration_min: 120,
      device_ids: [DEVICE.id],
      starts_at: null,
    });
  });
});
