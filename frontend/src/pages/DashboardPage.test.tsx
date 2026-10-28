import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderHook, act } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "../lib/queryClient";
import { RefreshProvider, useRefresh, zoomWindow } from "../lib/refresh";
import { mockApi } from "../test/mockApi";
import { renderApp } from "../test/renderApp";

describe("dashboard", () => {
  it("pokazuje podsumowanie: urządzenia, ruch WAN, klientów WiFi", async () => {
    mockApi();
    renderApp();
    expect(await screen.findByText("3 z 4")).toBeInTheDocument();
    expect(screen.getByText("1 nie odpowiadają")).toBeInTheDocument();
    expect(screen.getByText("42,3 Mb/s")).toBeInTheDocument();
    expect(screen.getByText("6,5 Mb/s")).toBeInTheDocument();
    expect(screen.getByText("17")).toBeInTheDocument();
  });

  it("pokazuje „–”, gdy nie ma danych o ruchu i klientach", async () => {
    mockApi({
      summary: {
        devices: { total: 1, up: 1, down: 0, unknown: 0 },
        wan: { in_bps: null, out_bps: null, interfaces: 0 },
        wifi_clients: null,
        last_poll_at: null,
        poll_interval_s: 30,
      },
    });
    renderApp();
    expect(await screen.findByText("1 z 1")).toBeInTheDocument();
    expect(screen.getAllByText("–").length).toBeGreaterThanOrEqual(3);
  });

  it("rysuje wykresy ruchu WAN i klientów WiFi z danymi z API", async () => {
    mockApi();
    renderApp();
    const charts = await screen.findAllByTestId("chart");
    expect(charts).toHaveLength(2);
    expect(charts[0]).toHaveTextContent("Pobieranie, Wysyłanie");
    expect(charts[0]).toHaveAttribute("data-points", "2");
    expect(charts[1]).toHaveTextContent("Klienci");
    expect(charts[0]).toHaveAccessibleName("Wykres: Ruch WAN, zakres 1 godz.");
  });

  it("pokazuje komunikat, gdy w wybranym zakresie nie ma jeszcze punktów", async () => {
    mockApi({ traffic: { interval_s: 30, points: [] } });
    renderApp();
    expect(await screen.findByText(/Brak danych w tym zakresie/)).toBeInTheDocument();
  });

  it("pokazuje błąd wykresu, gdy API nie odpowiada", async () => {
    mockApi({ overrides: { "GET /api/dashboard/traffic": { status: 500, body: { detail: "awaria" } } } });
    renderApp();
    expect(await screen.findByText("Nie udało się pobrać wykresu.")).toBeInTheDocument();
    expect(screen.getAllByTestId("chart")).toHaveLength(1); // wykres WiFi działa dalej
  });

  it("zmiana zakresu czasu pobiera wykresy za nowy zakres i zapamiętuje wybór", async () => {
    const user = userEvent.setup();
    const { calls } = mockApi();
    renderApp();
    const group = await screen.findByRole("group", { name: "Zakres czasu" });
    expect(within(group).getByRole("button", { name: "1 godz." })).toHaveAttribute("aria-pressed", "true");

    await user.click(within(group).getByRole("button", { name: "24 godz." }));
    expect(within(group).getByRole("button", { name: "24 godz." })).toHaveAttribute("aria-pressed", "true");
    await screen.findAllByTestId("chart");
    expect(calls.some((c) => c.path === "/api/dashboard/traffic?minutes=1440")).toBe(true);
    expect(calls.some((c) => c.path === "/api/dashboard/wifi?minutes=1440")).toBe(true);
    expect(localStorage.getItem("netpulse.range")).toBe("1440");
  });

  it("przy pustej liście urządzeń pokazuje instrukcję zamiast wykresów", async () => {
    mockApi({ devices: [] });
    renderApp();
    expect(await screen.findByText("Nie dodano jeszcze urządzeń")).toBeInTheDocument();
    expect(screen.queryByTestId("chart")).not.toBeInTheDocument();
  });
});

describe("odświeżanie w pasku górnym", () => {
  it("domyślnie co 30 s; wybór interwału zmienia etykietę i jest zapamiętany", async () => {
    const user = userEvent.setup();
    mockApi();
    renderApp();
    const trigger = await screen.findByRole("button", { name: /Automatyczne odświeżanie: co 30 s/ });
    await user.click(trigger);
    const menu = screen.getByRole("menu", { name: "Automatyczne odświeżanie" });
    expect(within(menu).getByRole("menuitemradio", { name: "co 30 s" })).toHaveAttribute("aria-checked", "true");

    await user.click(within(menu).getByRole("menuitemradio", { name: "co 1 min" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Automatyczne odświeżanie: co 1 min/ })).toBeInTheDocument();
    expect(localStorage.getItem("netpulse.refresh")).toBe("60");
  });

  it("opcja „Wyłączone” wyłącza automatyczne odświeżanie", async () => {
    const user = userEvent.setup();
    mockApi();
    renderApp();
    await user.click(await screen.findByRole("button", { name: /Automatyczne odświeżanie/ }));
    await user.click(screen.getByRole("menuitemradio", { name: "Wyłączone" }));
    expect(screen.getByRole("button", { name: /Automatyczne odświeżanie: Wyłączone/ })).toBeInTheDocument();
    expect(localStorage.getItem("netpulse.refresh")).toBe("0");
  });

  it("ostrzega, że odświeżanie częstsze niż odpytywanie urządzeń nie da nowych punktów", async () => {
    const user = userEvent.setup();
    mockApi();
    renderApp();
    await user.click(await screen.findByRole("button", { name: /Automatyczne odświeżanie/ }));
    const hint = await screen.findByText(/Urządzenia są odpytywane co 30 s/);
    expect(hint).not.toHaveClass("text-warning");
    await user.click(screen.getByRole("menuitemradio", { name: "co 5 s" }));
    await user.click(screen.getByRole("button", { name: /Automatyczne odświeżanie: co 5 s/ }));
    expect(screen.getByText(/Urządzenia są odpytywane co 30 s/)).toHaveClass("text-warning");
  });

  it("przycisk „Odśwież teraz” pobiera dane ponownie", async () => {
    const user = userEvent.setup();
    const { calls } = mockApi();
    renderApp();
    await screen.findByText("3 z 4");
    const before = calls.filter((c) => c.path === "/api/dashboard/summary").length;
    await user.click(screen.getByRole("button", { name: "Odśwież teraz" }));
    await screen.findByText("3 z 4");
    expect(calls.filter((c) => c.path === "/api/dashboard/summary").length).toBeGreaterThan(before);
  });

  it("Escape zamyka menu odświeżania", async () => {
    const user = userEvent.setup();
    mockApi();
    renderApp();
    await user.click(await screen.findByRole("button", { name: /Automatyczne odświeżanie/ }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});

describe("useRefresh", () => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={createQueryClient({ retry: false })}>
      <RefreshProvider>{children}</RefreshProvider>
    </QueryClientProvider>
  );

  it("interwał w sekundach zamienia na milisekundy dla TanStack Query, 0 → false", () => {
    const { result } = renderHook(() => useRefresh(), { wrapper });
    expect(result.current.refreshSeconds).toBe(30);
    expect(result.current.refetchInterval).toBe(30_000);
    act(() => result.current.setRefreshSeconds(5));
    expect(result.current.refetchInterval).toBe(5_000);
    act(() => result.current.setRefreshSeconds(0));
    expect(result.current.refetchInterval).toBe(false);
  });

  it("ignoruje nieprawidłowe zapamiętane wartości", () => {
    localStorage.setItem("netpulse.refresh", "7");
    localStorage.setItem("netpulse.range", "abc");
    const { result } = renderHook(() => useRefresh(), { wrapper });
    expect(result.current.refreshSeconds).toBe(30);
    expect(result.current.rangeMinutes).toBe(60);
  });

  it("odczytuje poprawnie zapamiętane wartości", () => {
    localStorage.setItem("netpulse.refresh", "0");
    localStorage.setItem("netpulse.range", "10080");
    const { result } = renderHook(() => useRefresh(), { wrapper });
    expect(result.current.refreshSeconds).toBe(0);
    expect(result.current.refetchInterval).toBe(false);
    expect(result.current.rangeMinutes).toBe(10080);
  });

  it("powiększenie: okno API, stos z „Wróć”, wybór zakresu kończy powiększenie", () => {
    const now = Date.parse("2026-10-29T12:00:00Z");
    // Fragment 11:00–11:29:40: okno kończy się o pełnej minucie po nim (11:30), czyli 30 min wstecz, i ma 30 min
    expect(zoomWindow(now - 60 * 60_000, now - 30 * 60_000 - 20_000, now)).toMatchObject({ offset: 30, minutes: 30 });
    // Fragment krótszy niż 5 minut – API przyjmuje co najmniej 5
    expect(zoomWindow(now - 60_000, now, now)).toMatchObject({ offset: 0, minutes: 5 });

    const { result } = renderHook(() => useRefresh(), { wrapper });
    expect(result.current.zoom).toBeNull();
    act(() => result.current.zoomTo(1000, 5000));
    act(() => result.current.zoomTo(2000, 3000));
    expect(result.current.zoom).toMatchObject({ from: 2000, to: 3000 });
    act(() => result.current.zoomOut());
    expect(result.current.zoom).toMatchObject({ from: 1000, to: 5000 });
    act(() => result.current.setRangeMinutes(360));
    expect(result.current.zoom).toBeNull();
  });

  it("pulpit publiczny nie powiększa (API przyjmuje tylko zakresy z pulpitu)", () => {
    const fixed = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={createQueryClient({ retry: false })}>
        <RefreshProvider fixed={{ refreshSeconds: 30, rangeMinutes: 60 }}>{children}</RefreshProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useRefresh(), { wrapper: fixed });
    expect(result.current.canZoom).toBe(false);
    act(() => result.current.zoomTo(1000, 5000));
    expect(result.current.zoom).toBeNull();
  });
});
