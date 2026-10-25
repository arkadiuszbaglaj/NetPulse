import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { formatDuration, thresholdFromDisplay, thresholdToDisplay, type Alert, type AlertRule } from "../lib/alerts";
import { mockApi } from "../test/mockApi";
import { renderApp } from "../test/renderApp";

const ALERT: Alert = {
  id: 1,
  rule_id: 1,
  state: "firing",
  severity: "critical",
  title: "Switch nie odpowiada",
  message: "timeout",
  device_id: 1,
  value: 300,
  peak: 300,
  started_at: new Date(Date.now() - 5 * 60_000).toISOString(),
  resolved_at: null,
  acked_at: null,
  acked_by: null,
};
const RESOLVED: Alert = {
  ...ALERT,
  id: 2,
  state: "resolved",
  severity: "warning",
  title: "CPU 95,0%",
  message: null,
  resolved_at: new Date(Date.now() - 60_000).toISOString(),
};
const RULE: AlertRule = {
  id: 1,
  name: "Wysokie CPU",
  enabled: true,
  kind: "metric",
  metric: "cpu_percent",
  op: ">",
  threshold: 90,
  duration_s: 600,
  severity: "warning",
  device_id: null,
  match: null,
  created_at: "2026-10-25T10:00:00Z",
};

describe("pomocnicze funkcje alertów", () => {
  it("formatuje czas trwania", () => {
    expect(formatDuration(45)).toBe("45 s");
    expect(formatDuration(300)).toBe("5 min");
    expect(formatDuration(5400)).toBe("1,5 godz.");
  });

  it("przelicza próg WAN między Mb/s a b/s", () => {
    expect(thresholdFromDisplay("wan_in_bps", 800)).toBe(800_000_000);
    expect(thresholdToDisplay("wan_in_bps", 800_000_000)).toBe(800);
    expect(thresholdFromDisplay("cpu_percent", 90)).toBe(90);
    expect(thresholdToDisplay("cpu_percent", null)).toBeNull();
  });
});

describe("dzwonek", () => {
  it("pokazuje liczbę niepotwierdzonych alertów", async () => {
    mockApi({ alerts: [ALERT, RESOLVED] });
    renderApp();
    const bell = await screen.findByRole("link", { name: "Alerty: 1 niepotwierdzonych" });
    expect(bell).toHaveAttribute("href", "/alerts");
    expect(bell).toHaveTextContent("1");
  });

  it("gaśnie po potwierdzeniu alertu, choć alert dalej jest aktywny", async () => {
    mockApi({ alerts: [ALERT, RESOLVED] });
    renderApp("/alerts");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Potwierdź" }));
    const bell = await screen.findByRole("link", { name: "Alerty: 1 aktywnych, wszystkie potwierdzone" });
    expect(bell).not.toHaveTextContent(/\d/);
  });

  it("bez alertów nie pokazuje licznika", async () => {
    mockApi();
    renderApp();
    const bell = await screen.findByRole("link", { name: "Alerty: brak aktywnych" });
    expect(bell).not.toHaveTextContent(/\d/);
  });
});

describe("strona Alerty", () => {
  it("pokazuje aktywne alerty i pozwala je potwierdzić", async () => {
    const { state, calls } = mockApi({ alerts: [ALERT, RESOLVED] });
    renderApp("/alerts");
    expect(await screen.findByText("Switch nie odpowiada")).toBeInTheDocument();
    expect(screen.queryByText("CPU 95,0%")).not.toBeInTheDocument(); // zakończony jest w historii

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Potwierdź" }));
    await waitFor(() => expect(state.alerts[0].acked_by).toBe("admin"));
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/alerts/1/ack")).toBe(true);
    expect(await screen.findByText(/potwierdził admin/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Potwierdź" })).not.toBeInTheDocument();
  });

  it("zakładka Historia pokazuje zakończone alerty, a filtr ważności je zawęża", async () => {
    mockApi({ alerts: [ALERT, RESOLVED] });
    renderApp("/alerts");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Historia" }));
    expect(await screen.findByText("CPU 95,0%")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Krytyczny" }));
    await waitFor(() => expect(screen.queryByText("CPU 95,0%")).not.toBeInTheDocument());
    expect(screen.getByText("Historia alertów jest pusta.")).toBeInTheDocument();
  });

  it("pokazuje komunikat, gdy nie ma aktywnych alertów", async () => {
    mockApi();
    renderApp("/alerts");
    expect(await screen.findByText(/Brak aktywnych alertów/)).toBeInTheDocument();
  });
});

describe("Ustawienia → Reguły alertów", () => {
  it("opisuje regułę czytelnie i pozwala ją wyłączyć", async () => {
    const { state } = mockApi({ rules: [RULE] });
    renderApp("/settings/alert-rules");
    expect(await screen.findByText(/CPU > 90%, 10 min/)).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("switch", { name: "Reguła włączona: Wysokie CPU" }));
    await waitFor(() => expect(state.rules[0].enabled).toBe(false));
  });

  it("dodaje regułę progu WAN z przeliczeniem Mb/s na b/s", async () => {
    const { state } = mockApi();
    renderApp("/settings/alert-rules");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Dodaj regułę" }));

    const form = await screen.findByRole("dialog", { name: "Nowa reguła" });
    await user.click(within(form).getByRole("button", { name: "Zapisz" }));
    expect(await within(form).findByText("Podaj nazwę reguły.")).toBeInTheDocument();

    await user.type(within(form).getByLabelText("Nazwa"), "Duży ruch");
    await user.selectOptions(within(form).getByLabelText("Metryka"), "wan_in_bps");
    expect(within(form).queryByLabelText("Urządzenie")).not.toBeInTheDocument(); // WAN to suma po routerach
    await user.type(within(form).getByLabelText(/Próg/), "800");
    await user.click(within(form).getByRole("button", { name: "Zapisz" }));

    await waitFor(() => expect(state.rules).toHaveLength(1));
    expect(state.rules[0]).toMatchObject({ name: "Duży ruch", kind: "metric", metric: "wan_in_bps", op: ">", threshold: 800_000_000, device_id: null });
  });

  it("reguła z agenta: kontener o wybranej nazwie, bez progu", async () => {
    const { state } = mockApi();
    renderApp("/settings/alert-rules");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Dodaj regułę" }));
    const form = await screen.findByRole("dialog", { name: "Nowa reguła" });
    await user.type(within(form).getByLabelText("Nazwa"), "Nextcloud");
    await user.selectOptions(within(form).getByLabelText("Rodzaj reguły"), "container_stopped");
    expect(within(form).queryByLabelText(/Próg/)).not.toBeInTheDocument();
    await user.type(within(form).getByLabelText("Tylko o nazwie (opcjonalnie)"), "nextcloud*");
    await user.click(within(form).getByRole("button", { name: "Zapisz" }));

    await waitFor(() => expect(state.rules).toHaveLength(1));
    expect(state.rules[0]).toMatchObject({ kind: "container_stopped", match: "nextcloud*", metric: null, threshold: null });
    expect(await screen.findByText(/Kontener Docker zatrzymany \(agent\) \(nextcloud\*\), 5 min/)).toBeInTheDocument();
  });

  it("filtr nazwy tylko dla metryk z agenta", async () => {
    mockApi();
    renderApp("/settings/alert-rules");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Dodaj regułę" }));
    const form = await screen.findByRole("dialog", { name: "Nowa reguła" });
    await user.selectOptions(within(form).getByLabelText("Metryka"), "cpu_percent");
    expect(within(form).queryByLabelText("Tylko o nazwie (opcjonalnie)")).not.toBeInTheDocument();
    await user.selectOptions(within(form).getByLabelText("Metryka"), "temp_c");
    expect(within(form).getByLabelText("Tylko o nazwie (opcjonalnie)")).toBeInTheDocument();
  });

  it("usuwa regułę po potwierdzeniu", async () => {
    const { state } = mockApi({ rules: [RULE] });
    renderApp("/settings/alert-rules");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Usuń regułę: Wysokie CPU" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Usuń" }));
    await waitFor(() => expect(state.rules).toHaveLength(0));
  });
});
