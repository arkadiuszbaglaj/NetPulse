import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { isValidWebhookUrl, type NotificationChannel } from "../../lib/notifications";
import { mockApi } from "../../test/mockApi";
import { renderApp } from "../../test/renderApp";

const CHANNEL: NotificationChannel = {
  id: 1,
  name: "Telegram",
  kind: "webhook",
  url_hint: "https://api.telegram.org/…",
  enabled: true,
  min_severity: "warning",
  notify_resolved: true,
  last_status: "ok",
  last_error: null,
  last_sent_at: "2026-10-25T10:00:00Z",
  created_at: "2026-10-25T09:00:00Z",
};

describe("adres webhooka", () => {
  it("przyjmuje tylko http i https z hostem", () => {
    expect(isValidWebhookUrl("https://hooks.example.com/abc")).toBe(true);
    expect(isValidWebhookUrl(" http://192.168.1.5:8123/api/webhook/x ")).toBe(true);
    for (const bad of ["", "ftp://x.example/y", "hooks.example.com", "javascript:alert(1)", "https://"]) {
      expect(isValidWebhookUrl(bad)).toBe(false);
    }
  });
});

describe("Ustawienia → Powiadomienia", () => {
  it("wyjaśnia, jak zacząć, gdy nie ma kanałów", async () => {
    mockApi();
    renderApp("/settings/notifications");
    expect(await screen.findByText("Nie dodano jeszcze powiadomień")).toBeInTheDocument();
  });

  it("pokazuje kanał z hostem (bez tokenu) i stanem ostatniej wysyłki", async () => {
    mockApi({ channels: [CHANNEL] });
    renderApp("/settings/notifications");
    expect(await screen.findByText("Telegram")).toBeInTheDocument();
    expect(screen.getByText(/https:\/\/api\.telegram\.org\/… · od ostrzeżeń · z zakończeniami/)).toBeInTheDocument();
    expect(screen.getByText("wysłano")).toBeInTheDocument();
  });

  it("pokazuje błąd ostatniej wysyłki", async () => {
    mockApi({ channels: [{ ...CHANNEL, last_status: "error", last_error: "RuntimeError: HTTP 404" }] });
    renderApp("/settings/notifications");
    expect(await screen.findByText("błąd wysyłki")).toBeInTheDocument();
    expect(screen.getByText("RuntimeError: HTTP 404")).toBeInTheDocument();
  });

  it("dodaje webhook po poprawnym adresie", async () => {
    const { calls } = mockApi();
    renderApp("/settings/notifications");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Dodaj webhook" }));
    const dialog = await screen.findByRole("dialog", { name: "Dodaj webhook" });

    await user.click(within(dialog).getByRole("button", { name: "Zapisz" }));
    expect(within(dialog).getByText("Podaj nazwę.")).toBeInTheDocument();
    expect(within(dialog).getByText(/Podaj adres zaczynający się od http/)).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText("Nazwa"), "Discord");
    await user.type(within(dialog).getByLabelText("Adres webhooka"), "https://discord.com/api/webhooks/1/TOKEN");
    await user.selectOptions(within(dialog).getByLabelText("Wysyłaj od ważności"), "critical");
    await user.click(within(dialog).getByRole("checkbox", { name: /gdy alert się zakończy/ }));
    await user.click(within(dialog).getByRole("button", { name: "Zapisz" }));

    expect(await screen.findByText("Discord")).toBeInTheDocument();
    const post = calls.find((c) => c.method === "POST" && c.path === "/api/notification-channels");
    expect(post?.body).toEqual({
      name: "Discord",
      min_severity: "critical",
      notify_resolved: false,
      url: "https://discord.com/api/webhooks/1/TOKEN",
    });
    expect(screen.queryByText(/TOKEN/)).not.toBeInTheDocument(); // sekret nie wraca do widoku
  });

  it("edycja z pustym adresem nie zmienia zapisanego adresu", async () => {
    const { calls } = mockApi({ channels: [CHANNEL] });
    renderApp("/settings/notifications");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edytuj Telegram" }));
    const dialog = await screen.findByRole("dialog", { name: "Edycja: Telegram" });
    await user.clear(within(dialog).getByLabelText("Nazwa"));
    await user.type(within(dialog).getByLabelText("Nazwa"), "Telegram domowy");
    await user.click(within(dialog).getByRole("button", { name: "Zapisz" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.body).toEqual({ name: "Telegram domowy", min_severity: "warning", notify_resolved: true });
    expect(await screen.findByText("Telegram domowy")).toBeInTheDocument();
  });

  it("wysyła wiadomość próbną i pokazuje wynik", async () => {
    mockApi({ channels: [CHANNEL] });
    renderApp("/settings/notifications");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Wyślij wiadomość próbną Telegram" }));
    expect(await screen.findByText("Wiadomość próbna została wysłana.")).toBeInTheDocument();
  });

  it("pokazuje powód, gdy wiadomość próbna nie dotarła", async () => {
    mockApi({ channels: [CHANNEL], channelTest: { ok: false, error: "RuntimeError: HTTP 500" } });
    renderApp("/settings/notifications");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Wyślij wiadomość próbną Telegram" }));
    expect(await screen.findByText("Nie udało się wysłać: RuntimeError: HTTP 500")).toBeInTheDocument();
  });

  it("wyłącza kanał przełącznikiem", async () => {
    const { calls } = mockApi({ channels: [CHANNEL] });
    renderApp("/settings/notifications");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("switch", { name: /Telegram/ }));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ enabled: false }));
  });

  it("usuwa kanał po potwierdzeniu", async () => {
    const { calls } = mockApi({ channels: [CHANNEL] });
    renderApp("/settings/notifications");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Usuń Telegram" }));
    const dialog = await screen.findByRole("dialog", { name: "Usunąć webhook?" });
    await user.click(within(dialog).getByRole("button", { name: "Usuń" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    expect(await screen.findByText("Nie dodano jeszcze powiadomień")).toBeInTheDocument();
  });

  it("jest w menu Ustawień", async () => {
    mockApi();
    renderApp("/settings/notifications");
    expect((await screen.findAllByRole("link", { name: "Powiadomienia" })).length).toBeGreaterThan(0);
  });
});
