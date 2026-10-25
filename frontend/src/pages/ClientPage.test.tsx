import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { presenceTimeline } from "../lib/clients";
import { CLIENTS, CONTROLLER, mockApi } from "../test/mockApi";
import { renderApp } from "../test/renderApp";

const [PHONE, TV] = CLIENTS;

describe("strona klienta", () => {
  it("z listy klientów prowadzi do szczegółów z sygnałem, obecnością i historią", async () => {
    mockApi({ clients: CLIENTS, controllers: [CONTROLLER] });
    renderApp("/clients");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("link", { name: "Telefon Ani" }));

    expect(await screen.findByRole("heading", { level: 1, name: "Telefon Ani" })).toBeInTheDocument();
    expect(window.location.pathname).toBe(`/clients/${PHONE.mac}`);
    expect(screen.getByText("w sieci")).toBeInTheDocument();
    expect(screen.getByText("-52 dBm (Sygnał bardzo dobry)")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "U6+" })).toHaveAttribute("href", "/devices/3");
    expect(await screen.findByText("Siła sygnału")).toBeInTheDocument();
    expect(screen.getByText("Prędkość łącza")).toBeInTheDocument();
    expect(await screen.findByText(/Przejście na: U6\+/)).toBeInTheDocument();
    expect(await screen.findByRole("list", { name: "Obecność w sieci w czasie" })).toBeInTheDocument();
  });

  it("klient po kablu: bez wykresów sygnału, z portem switcha", async () => {
    mockApi({ clients: CLIENTS });
    renderApp(`/clients/${TV.mac}`);
    expect(await screen.findByRole("heading", { level: 1, name: "Telewizor" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "USW · port 7" })).toHaveAttribute("href", "/devices/2");
    expect(screen.queryByText("Siła sygnału")).not.toBeInTheDocument();
  });

  it("nieznany klient: komunikat", async () => {
    mockApi({ clients: CLIENTS });
    renderApp("/clients/02:00:00:00:00:99");
    expect(await screen.findByText(/nie widział jeszcze takiego klienta/)).toBeInTheDocument();
  });
});

describe("oś obecności", () => {
  it("dzieli zakres na kubełki od początku do teraz i liczy udział czasu w sieci", () => {
    const now = Date.UTC(2026, 9, 25, 12, 0, 10);
    const slots = presenceTimeline(
      { interval_s: 30, expected: 2, buckets: [{ time: "2026-10-25T11:59:30Z", samples: 1 }, { time: "2026-10-25T12:00:00Z", samples: 3 }] },
      1,
      now,
    );
    expect(slots.map((s) => [new Date(s.start).toISOString(), s.share])).toEqual([
      ["2026-10-25T11:59:00.000Z", 0],
      ["2026-10-25T11:59:30.000Z", 0.5],
      ["2026-10-25T12:00:00.000Z", 1],
    ]);
  });
});
