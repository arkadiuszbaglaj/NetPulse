import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { reloadPage } from "../../lib/reload";
import { IDLE_JOB, RUNNING_JOB, UPDATE_AVAILABLE, UPDATES, UP_TO_DATE, mockApi } from "../../test/mockApi";
import { renderApp } from "../../test/renderApp";

// Po aktualizacji strona ładuje się od nowa – w testach tylko sprawdzamy, że do tego dochodzi
vi.mock("../../lib/reload", () => ({ RELOAD_DELAY_MS: 30, reloadPage: vi.fn() }));

const available = { ...UPDATES, info: UPDATE_AVAILABLE };

async function openPage(init: Parameters<typeof mockApi>[0] = {}) {
  const user = userEvent.setup();
  const api = mockApi(init);
  const view = renderApp("/settings/update");
  await screen.findByRole("heading", { name: "Aktualizacja" });
  return { user, ...api, ...view };
}

describe("aktualizacja – stan początkowy", () => {
  it("pokazuje zainstalowaną wersję i commit", async () => {
    await openPage();
    expect(await screen.findByText("0.2.0")).toBeInTheDocument();
    expect(screen.getByText("commit abc1234")).toBeInTheDocument();
    expect(screen.getByText("Jeszcze nie sprawdzano, czy jest nowa wersja.")).toBeInTheDocument();
  });

  it("gdy aktualizacja z panelu jest wyłączona, podpowiada polecenie i nie pokazuje przycisków", async () => {
    await openPage({
      updates: {
        ...UPDATES,
        updater: { configured: false, reachable: false, message: "Aktualizacja z panelu jest wyłączona. Zaktualizuj poleceniem: netpulse update" },
      },
    });
    expect(await screen.findByText(/Aktualizacja z panelu jest niedostępna/)).toBeInTheDocument();
    expect(screen.getByText(/Zaktualizuj poleceniem: netpulse update/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sprawdź aktualizacje" })).not.toBeInTheDocument();
  });

  it("gdy usługa aktualizacji nie odpowiada, pokazuje powód", async () => {
    await openPage({
      updates: { ...UPDATES, updater: { configured: true, reachable: false, message: "Usługa aktualizacji nie odpowiada. Sprawdź: netpulse status" } },
    });
    expect(await screen.findByText(/Usługa aktualizacji nie odpowiada/)).toBeInTheDocument();
  });
});

describe("aktualizacja z terminala", () => {
  const cli = () => screen.getByRole("region", { name: "Aktualizacja z terminala" });

  it("podpowiedź z komendą jest widoczna zawsze", async () => {
    await openPage();
    expect(within(cli()).getByText("netpulse update")).toBeInTheDocument();
  });

  it("jest widoczna także, gdy aktualizacja z panelu jest wyłączona", async () => {
    await openPage({
      updates: { ...UPDATES, updater: { configured: false, reachable: false, message: "Aktualizacja z panelu jest wyłączona." } },
    });
    await screen.findByText(/Aktualizacja z panelu jest niedostępna/);
    expect(within(cli()).getByText("netpulse update")).toBeInTheDocument();
  });

  it("jest widoczna także, gdy usługa aktualizacji nie odpowiada", async () => {
    await openPage({
      updates: { ...UPDATES, updater: { configured: true, reachable: false, message: "Usługa aktualizacji nie odpowiada." } },
    });
    await screen.findByText(/Usługa aktualizacji nie odpowiada/);
    expect(within(cli()).getByText("netpulse update")).toBeInTheDocument();
  });

  it("zostaje widoczna podczas aktualizacji z panelu", async () => {
    await openPage({ updates: { ...UPDATES, job: RUNNING_JOB } });
    await screen.findByRole("heading", { name: "Trwa aktualizacja" });
    expect(within(cli()).getByText("netpulse update")).toBeInTheDocument();
  });
});

describe("sprawdzanie aktualizacji", () => {
  it("pokazuje, że masz najnowszą wersję", async () => {
    const { user, calls } = await openPage({ afterCheck: { ...UPDATES, info: UP_TO_DATE } });
    await user.click(await screen.findByRole("button", { name: "Sprawdź aktualizacje" }));
    expect(await screen.findByText("Masz najnowszą wersję")).toBeInTheDocument();
    expect(screen.getByText(/Sprawdzono:/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Aktualizuj/ })).not.toBeInTheDocument();
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/updates/check")).toBe(true);
  });

  it("pokazuje nową wersję i listę zmian", async () => {
    const { user } = await openPage({ afterCheck: available });
    await user.click(await screen.findByRole("button", { name: "Sprawdź aktualizacje" }));
    expect(await screen.findByText("Dostępna nowa wersja: 0.3.0")).toBeInTheDocument();
    const changes = screen.getByRole("region", { name: "Co nowego" });
    expect(within(changes).getByText("Etap B: druga zmiana")).toBeInTheDocument();
    expect(within(changes).getByText("aaa1111")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Aktualizuj do 0.3.0" })).toBeInTheDocument();
  });

  it("skraca długą listę zmian", async () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ sha: `c${i}`.padEnd(7, "0"), subject: `Zmiana ${i}` }));
    const { user } = await openPage({ afterCheck: { ...UPDATES, info: { ...UPDATE_AVAILABLE, changes: many, behind: 14 } } });
    await user.click(await screen.findByRole("button", { name: "Sprawdź aktualizacje" }));
    expect(await screen.findByText("Zmiana 9")).toBeInTheDocument();
    expect(screen.queryByText("Zmiana 10")).not.toBeInTheDocument();
    expect(screen.getByText("i 4 więcej")).toBeInTheDocument();
  });

  it("pokazuje błąd, gdy źródło aktualizacji jest niedostępne", async () => {
    const { user, state } = await openPage();
    state.overrides["POST /api/updates/check"] = {
      status: 502,
      body: { detail: "Nie udało się połączyć ze źródłem aktualizacji: timeout" },
    };
    await user.click(await screen.findByRole("button", { name: "Sprawdź aktualizacje" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Nie udało się połączyć ze źródłem aktualizacji");
  });

  it("ostrzega o lokalnych zmianach uniemożliwiających aktualizację i nie daje przycisku", async () => {
    await openPage({ updates: { ...UPDATES, info: { ...UP_TO_DATE, diverged: true, behind: 1, ahead: 1 } } });
    expect(await screen.findByText(/lokalne zmiany/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Aktualizuj/ })).not.toBeInTheDocument();
  });
});

describe("uprawnienia", () => {
  it("zwykły użytkownik widzi stan, ale nie może sprawdzać ani aktualizować", async () => {
    await openPage({ admin: false, updates: available });
    expect(await screen.findByText("Dostępna nowa wersja: 0.3.0")).toBeInTheDocument();
    expect(screen.getByText("Aktualizację może zlecić tylko administrator.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sprawdź aktualizacje" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Aktualizuj/ })).not.toBeInTheDocument();
  });
});

describe("instalowanie aktualizacji", () => {
  it("prosi o potwierdzenie, a „Anuluj” niczego nie uruchamia", async () => {
    const { user, calls } = await openPage({ updates: available });
    await user.click(await screen.findByRole("button", { name: "Aktualizuj do 0.3.0" }));
    const dialog = await screen.findByRole("dialog", { name: "Zaktualizować NetPulse?" });
    expect(within(dialog).getByText(/kopia bazy danych/)).toBeInTheDocument();
    expect(within(dialog).getByText(/sam wróci do poprzedniej/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Anuluj" })).toHaveFocus();
    await user.click(within(dialog).getByRole("button", { name: "Anuluj" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(calls.some((c) => c.path === "/api/updates/apply")).toBe(false);
  });

  it("po potwierdzeniu uruchamia aktualizację i pokazuje postęp z dziennikiem", async () => {
    const { user, calls } = await openPage({ updates: available });
    await user.click(await screen.findByRole("button", { name: "Aktualizuj do 0.3.0" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Aktualizuj" }));

    expect(await screen.findByRole("heading", { name: "Trwa aktualizacja" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/updates/apply")).toBe(true);
    expect(screen.getByText("z wersji 0.2.0 do 0.3.0")).toBeInTheDocument();
    const steps = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(steps).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Kopia bazy danych"),
        expect.stringMatching(/Budowanie.*w toku/),
        expect.stringMatching(/Sprawdzanie, czy działa.*oczekuje/),
      ]),
    );
    // w trakcie aktualizacji nie da się uruchomić drugiej ani ponownie sprawdzać
    expect(screen.queryByRole("button", { name: /Aktualizuj do/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sprawdź aktualizacje" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Szczegóły" }));
    expect(screen.getByLabelText("Dziennik aktualizacji")).toHaveTextContent("Step 1/8 : FROM node");
    await user.click(screen.getByRole("button", { name: "Ukryj szczegóły" }));
    expect(screen.queryByLabelText("Dziennik aktualizacji")).not.toBeInTheDocument();
  });

  it("pokazuje błąd, gdy aktualizacja już trwa (409)", async () => {
    const { user, state } = await openPage({ updates: available });
    state.overrides["POST /api/updates/apply"] = { status: 409, body: { detail: "Aktualizacja już trwa." } };
    await user.click(await screen.findByRole("button", { name: "Aktualizuj do 0.3.0" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Aktualizuj" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Aktualizacja już trwa.");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("po sukcesie ładuje stronę od nowa, żeby użyć nowej wersji", async () => {
    const { user, state, client } = await openPage({ updates: available });
    vi.mocked(reloadPage).mockClear();
    await user.click(await screen.findByRole("button", { name: "Aktualizuj do 0.3.0" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Aktualizuj" }));
    await screen.findByRole("heading", { name: "Trwa aktualizacja" });

    state.updates = {
      ...UPDATES,
      installed_version: "0.3.0",
      job: {
        ...RUNNING_JOB,
        state: "ok",
        phase: null,
        phases: RUNNING_JOB.phases.map((p) => ({ ...p, status: "done" as const })),
        finished_at: "2026-10-24T20:05:00Z",
      },
    };
    await client.invalidateQueries({ queryKey: ["updates"] });
    expect(await screen.findByRole("heading", { name: "Zaktualizowano" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Odśwież stronę" })).toBeInTheDocument();
    await waitFor(() => expect(reloadPage).toHaveBeenCalled());
  });

  it("nie przeładowuje strony, gdy otwarto ją po wcześniej zakończonej aktualizacji", async () => {
    vi.mocked(reloadPage).mockClear();
    await openPage({
      updates: { ...UPDATES, job: { ...RUNNING_JOB, state: "ok", phases: RUNNING_JOB.phases.map((p) => ({ ...p, status: "done" as const })) } },
    });
    expect(await screen.findByRole("heading", { name: "Zaktualizowano" })).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 80));
    expect(reloadPage).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Odśwież stronę" })).not.toBeInTheDocument();
  });

  it("pokazuje błąd i dziennik po nieudanej aktualizacji", async () => {
    await openPage({
      updates: {
        ...UPDATES,
        job: {
          ...RUNNING_JOB,
          state: "failed",
          phases: RUNNING_JOB.phases.map((p) => (p.id === "build" ? { ...p, status: "failed" as const } : p)),
          error: "Budowanie nowej wersji nie powiodło się.",
          note: "Usługi działają dalej na poprzedniej wersji.",
          finished_at: "2026-10-24T20:03:00Z",
        },
      },
    });
    expect(await screen.findByRole("heading", { name: "Aktualizacja nie powiodła się" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Budowanie nowej wersji nie powiodło się.");
    expect(screen.getByText("Usługi działają dalej na poprzedniej wersji.")).toBeInTheDocument();
    const steps = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(steps).toEqual(expect.arrayContaining([expect.stringMatching(/Budowanie.*błąd/)]));
  });

  it("informuje o przywróceniu poprzedniej wersji", async () => {
    await openPage({
      updates: {
        ...UPDATES,
        job: {
          ...RUNNING_JOB,
          state: "rolled_back",
          phases: [...RUNNING_JOB.phases, { id: "rollback", status: "done" as const }],
          error: "Nowa wersja nie odpowiada po 150 s.",
          note: "Przywrócono poprzednią wersję. Dane są nienaruszone.",
        },
      },
    });
    expect(await screen.findByRole("heading", { name: "Przywrócono poprzednią wersję" })).toBeInTheDocument();
    expect(screen.getByText("Przywracanie poprzedniej wersji")).toBeInTheDocument();
    expect(screen.getByText("Przywrócono poprzednią wersję. Dane są nienaruszone.")).toBeInTheDocument();
  });

  it("gdy API chwilowo nie odpowiada podczas aktualizacji, pokazuje komunikat o restarcie i nie traci postępu", async () => {
    const { client, fetchMock } = await openPage({ updates: { ...UPDATES, job: RUNNING_JOB } });
    expect(await screen.findByRole("heading", { name: "Trwa aktualizacja" })).toBeInTheDocument();
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await client.invalidateQueries({ queryKey: ["updates"] });
    expect(await screen.findByText(/Usługi się restartują/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Trwa aktualizacja" })).toBeInTheDocument();
  });

  it("job w stanie idle nie rysuje karty postępu", async () => {
    await openPage({ updates: { ...UPDATES, job: IDLE_JOB } });
    await screen.findByText("0.2.0");
    expect(screen.queryByRole("heading", { name: "Trwa aktualizacja" })).not.toBeInTheDocument();
  });
});
