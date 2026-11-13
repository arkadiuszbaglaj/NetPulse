import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockApi } from "../test/mockApi";
import { renderApp } from "../test/renderApp";
import { fmtDuration, fmtPercent, reportMonths } from "./ReportsPage";

describe("Raporty", () => {
  it("jest w menu w grupie Zdarzenia i pokazuje podsumowanie poprzedniego miesiąca", async () => {
    const { calls } = mockApi();
    renderApp("/reports");
    expect(await screen.findByRole("heading", { level: 1, name: "Raport miesięczny" })).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Menu główne" });
    expect(within(nav).getByRole("link", { name: "Raporty" })).toHaveAttribute("href", "/reports");

    const prev = reportMonths()[1].value;
    await waitFor(() => expect(calls.some((c) => c.path === `/api/reports/monthly?month=${prev}`)).toBe(true));
    expect(await screen.findByText("99,998%")).toBeInTheDocument(); // urządzenia, ważona średnia
    expect(screen.getByText("krytyczne 1 · ostrzeżenia 1")).toBeInTheDocument();
    expect(screen.getByText(/Sprawdzenia i SLA łączy WAN liczone od/)).toBeInTheDocument();

    const devices = screen.getByRole("table", { name: "Urządzenia" });
    const ucg = within(devices).getByText("UCG Ultra").closest("tr") as HTMLElement;
    expect(within(ucg).getByText("99,995%")).toBeInTheDocument();
    expect(within(ucg).getByText("2 min")).toBeInTheDocument();
    const wan = screen.getByRole("table", { name: "Łącza WAN" });
    expect(within(wan).getByText("512 GB")).toBeInTheDocument();
    const alerts = screen.getByRole("table", { name: "Alerty" });
    const rows = within(alerts).getAllByRole("row");
    expect(within(rows[1]).getByText("Urządzenie nie odpowiada")).toBeInTheDocument(); // najdłuższy pierwszy
    expect(within(rows[1]).getByText("1 h (trwa)")).toBeInTheDocument();
  });

  it("linki do pobrania PDF i CSV idą za wybranym miesiącem", async () => {
    const user = userEvent.setup();
    const { calls } = mockApi();
    renderApp("/reports");
    const months = reportMonths();
    const pdf = await screen.findByRole("link", { name: "Pobierz PDF" });
    expect(pdf).toHaveAttribute("href", `/api/reports/monthly.pdf?month=${months[1].value}&lang=pl`);
    await user.selectOptions(screen.getByLabelText("Miesiąc"), months[0].value);
    expect(pdf).toHaveAttribute("href", `/api/reports/monthly.pdf?month=${months[0].value}&lang=pl`);
    expect(screen.getByRole("link", { name: "Pobierz CSV" })).toHaveAttribute("href", `/api/reports/monthly.csv?month=${months[0].value}&lang=pl`);
    await waitFor(() => expect(calls.some((c) => c.path === `/api/reports/monthly?month=${months[0].value}`)).toBe(true));
  });

  it("lista miesięcy i formatowanie", () => {
    const months = reportMonths(new Date(2026, 0, 15));
    expect(months[0]).toEqual({ value: "2026-01", label: "styczeń 2026 (do teraz)" });
    expect(months[1]).toEqual({ value: "2025-12", label: "grudzień 2025" });
    expect(months).toHaveLength(13);
    expect(fmtPercent(99.9999)).toBe("100,000%");
    expect(fmtPercent(100)).toBe("100,00%");
    expect(fmtPercent(null)).toBe("–");
    expect(fmtDuration(3900)).toBe("1 h 5 min");
    expect(fmtDuration(3 * 86400 + 7200)).toBe("3 d 2 h");
  });
});
