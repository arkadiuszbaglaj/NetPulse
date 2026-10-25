import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Backup } from "../../lib/backups";
import { mockApi } from "../../test/mockApi";
import { renderApp } from "../../test/renderApp";

const OLD: Backup = { name: "netpulse-20261020-030000.sql.gz", kind: "update", size_bytes: 1_200_000, created_at: "2026-10-20T03:00:00+02:00" };

describe("Ustawienia → Kopia zapasowa", () => {
  it("tworzy kopię i pokazuje ją na liście z linkiem do pobrania", async () => {
    mockApi();
    renderApp("/settings/backups");
    const user = userEvent.setup();
    expect(await screen.findByText("Nie ma jeszcze żadnej kopii")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Utwórz kopię teraz" }));
    expect(await screen.findByText("Kopia gotowa. Możesz ją pobrać na komputer.")).toBeInTheDocument();
    expect(screen.getByText(/kopia ręczna · 2(,|\.)\d MB/)).toBeInTheDocument();
    const link = screen.getAllByRole("link", { name: /^Pobierz:/ })[0];
    expect(link).toHaveAttribute("href", "/api/backups/netpulse-manual-20261025-120000.sql.gz/download");
  });

  it("wgrywa kopię z komputera jako surowy plik", async () => {
    const { calls } = mockApi();
    renderApp("/settings/backups");
    const user = userEvent.setup();
    await screen.findByText("Nie ma jeszcze żadnej kopii");
    const file = new File(["gz"], "netpulse-manual-20261020-080000.sql.gz", { type: "application/gzip" });
    await user.upload(screen.getByLabelText("Wgraj kopię z komputera"), file);
    expect(await screen.findByText(/Kopia wgrana i sprawdzona/)).toBeInTheDocument();
    expect(screen.getByText(/wgrana z komputera · 1 MB/)).toBeInTheDocument();
    const call = calls.find((c) => c.path === "/api/backups/upload");
    expect(call?.method).toBe("POST");
    expect(call?.body).toBe(file);
  });

  it("odrzuca plik, który nie jest .gz, bez wysyłania", async () => {
    const { calls } = mockApi();
    renderApp("/settings/backups");
    const user = userEvent.setup({ applyAccept: false });
    await screen.findByText("Nie ma jeszcze żadnej kopii");
    await user.upload(screen.getByLabelText("Wgraj kopię z komputera"), new File(["x"], "zdjecie.jpg", { type: "image/jpeg" }));
    expect(await screen.findByText(/Wybierz plik kopii NetPulse z rozszerzeniem .sql.gz/)).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/api/backups/upload")).toBe(false);
  });

  it("przywrócenie wymaga potwierdzenia i pokazuje ekran oczekiwania", async () => {
    const { state, calls } = mockApi({ backups: { backups: [OLD], restore: { state: "idle" } } });
    renderApp("/settings/backups");
    const user = userEvent.setup();
    expect(await screen.findByText(/przed aktualizacją/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Przywróć:/ }));
    const dialog = await screen.findByRole("dialog", { name: "Przywrócić bazę z kopii?" });
    expect(within(dialog).getByText(/sam zrobi kopię obecnego stanu/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Przywróć bazę" }));
    expect(await screen.findByText("Przywracam bazę z kopii…")).toBeInTheDocument();
    expect(state.backups.restore.state).toBe("running");
    expect(calls.some((c) => c.method === "POST" && c.path === `/api/backups/${OLD.name}/restore`)).toBe(true);
    expect(screen.queryByRole("button", { name: /^Przywróć:/ })).not.toBeInTheDocument();
  });

  it("pokazuje wynik ostatniego przywracania i pozwala usunąć kopię", async () => {
    const { state } = mockApi({
      backups: { backups: [OLD], restore: { state: "failed", backup: OLD.name, error: "Wczytanie kopii nie powiodło się." } },
    });
    renderApp("/settings/backups");
    const user = userEvent.setup();
    expect(await screen.findByText("Przywracanie nie powiodło się: Wczytanie kopii nie powiodło się.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Usuń:/ }));
    await user.click(within(await screen.findByRole("dialog", { name: "Usunąć kopię?" })).getByRole("button", { name: "Usuń" }));
    await waitFor(() => expect(state.backups.backups).toEqual([]));
  });
});
