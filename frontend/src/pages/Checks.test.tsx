import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Check } from "../lib/checks";
import { metricFormatter } from "../lib/format";
import { mockApi } from "../test/mockApi";
import { renderApp } from "../test/renderApp";

const check = (over: Partial<Check>): Check => ({
  id: 1,
  name: "Internet – Google DNS",
  kind: "ping",
  target: "8.8.8.8",
  port: null,
  interval_s: 30,
  timeout_s: 3,
  enabled: true,
  expect_status: null,
  keyword: null,
  verify_tls: true,
  status: "up",
  status_since: "2026-10-28T09:00:00Z",
  last_checked_at: "2026-10-28T10:00:00Z",
  last_ok_at: "2026-10-28T10:00:00Z",
  last_error: null,
  last_latency_ms: 15.2,
  created_at: "2026-10-28T08:00:00Z",
  availability_24h: 99.5,
  loss_percent: 0,
  jitter_ms: 0.4,
  status_code: null,
  cert_days: null,
  ...over,
});

describe("Dostępność", () => {
  it("pusta lista proponuje gotowe sprawdzenia, formularz testuje i zapisuje ping", async () => {
    const { state, calls } = mockApi();
    renderApp("/checks");
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Internet – Google DNS" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Nowe sprawdzenie",
    });
    expect(within(dialog).getByLabelText("Adres IP lub nazwa hosta")).toHaveValue("8.8.8.8");
    await user.click(within(dialog).getByRole("button", { name: "Sprawdź teraz" }));
    expect(await within(dialog).findByText(/Dostępne: opóźnienie 15 ms · utrata 0% · jitter 0,4 ms/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Zapisz" }));

    await waitFor(() => expect(state.checks).toHaveLength(1));
    const saved = calls.find((c) => c.method === "POST" && c.path === "/api/checks");
    expect(saved?.body).toMatchObject({
      kind: "ping",
      target: "8.8.8.8",
      interval_s: 30,
      timeout_s: 3,
      port: null,
      expect_status: null,
    });
  });

  it("HTTP wymaga adresu z http(s), TCP – portu; limit czasu krótszy niż odstęp", async () => {
    mockApi();
    renderApp("/checks");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Dodaj sprawdzenie" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Nazwa"), "NAS");
    await user.selectOptions(within(dialog).getByLabelText("Rodzaj"), "http");
    await user.type(within(dialog).getByLabelText("Adres strony"), "nas.lan");
    await user.click(within(dialog).getByRole("button", { name: "Zapisz" }));
    expect(await within(dialog).findByText("Adres musi zaczynać się od http:// albo https://.")).toBeInTheDocument();

    await user.selectOptions(within(dialog).getByLabelText("Rodzaj"), "tcp");
    await user.selectOptions(within(dialog).getByLabelText("Sprawdzaj co"), "30");
    const timeout = within(dialog).getByLabelText("Limit czasu (s)");
    await user.clear(timeout);
    await user.type(timeout, "30");
    await user.click(within(dialog).getByRole("button", { name: "Zapisz" }));
    expect(await within(dialog).findByText("Limit czasu musi być krótszy niż odstęp między sprawdzeniami.")).toBeInTheDocument();
    expect(within(dialog).getByText("Podaj port od 1 do 65535.")).toBeInTheDocument();
  });

  it("lista pokazuje stan, wyniki i błąd niedostępnego sprawdzenia", async () => {
    mockApi({
      checks: [
        check({}),
        check({
          id: 2,
          name: "Pi-hole",
          kind: "http",
          target: "https://pihole.lan/admin",
          status: "down",
          last_error: "Kod HTTP 502 (oczekiwany 200-399)",
          last_latency_ms: 40,
          status_code: 502,
          cert_days: 61,
          loss_percent: null,
          jitter_ms: null,
          availability_24h: 87.25,
        }),
      ],
    });
    renderApp("/checks");
    expect(await screen.findByText("Nie przechodzi: 1 z 2.")).toBeInTheDocument();
    const rows = ["Internet – Google DNS", "Pi-hole"].map((name) => screen.getByText(name).closest("li") as HTMLElement);
    expect(within(rows[0]).getByText("dostępne")).toBeInTheDocument();
    expect(within(rows[0]).getByText(/opóźnienie 15 ms · utrata 0% · jitter 0,4 ms/)).toBeInTheDocument();
    expect(within(rows[0]).getByText("99,5% / 24 h")).toBeInTheDocument();
    expect(within(rows[0]).getByText(/Ping · 8\.8\.8\.8 · co 30 s/)).toBeInTheDocument();
    expect(within(rows[1]).getByText("niedostępne")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Kod HTTP 502 (oczekiwany 200-399)")).toBeInTheDocument();
    expect(within(rows[1]).getByText(/kod 502 · certyfikat: 61 dni/)).toBeInTheDocument();
  });

  it("formatuje opóźnienie i ważność certyfikatu", () => {
    expect(metricFormatter("ms", "bits")(0.98)).toBe("1 ms");
    expect(metricFormatter("ms", "bits")(4.25)).toBe("4,3 ms");
    expect(metricFormatter("ms", "bits")(152.4)).toBe("152 ms");
    expect(metricFormatter("days", "bits")(13.6)).toBe("14 dni");
  });
});
