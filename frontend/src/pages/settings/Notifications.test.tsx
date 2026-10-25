import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { isValidNtfyUrl, isValidWebhookUrl, parseRecipients, type NotificationChannel } from "../../lib/notifications";
import { mockApi } from "../../test/mockApi";
import { renderApp } from "../../test/renderApp";

const CHANNEL: NotificationChannel = {
  id: 1,
  name: "Telegram",
  kind: "webhook",
  url_hint: "https://api.telegram.org/…",
  has_secret: false,
  email: null,
  enabled: true,
  min_severity: "warning",
  notify_resolved: true,
  quiet_from: null,
  quiet_to: null,
  quiet_critical: true,
  quiet_pending: 0,
  timezone: "Europe/Warsaw",
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
    await user.click(await screen.findByRole("button", { name: "Dodaj kanał" }));
    const dialog = await screen.findByRole("dialog", { name: "Dodaj kanał powiadomień" });

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
      kind: "webhook",
      min_severity: "critical",
      notify_resolved: false,
      quiet_from: null,
      quiet_to: null,
      quiet_critical: true,
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
    expect(patch?.body).toEqual({ name: "Telegram domowy", min_severity: "warning", notify_resolved: true, quiet_from: null, quiet_to: null, quiet_critical: true });
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
    const dialog = await screen.findByRole("dialog", { name: "Usunąć kanał?" });
    await user.click(within(dialog).getByRole("button", { name: "Usuń" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    expect(await screen.findByText("Nie dodano jeszcze powiadomień")).toBeInTheDocument();
  });

  it("jest w menu Ustawień", async () => {
    mockApi();
    renderApp("/settings/notifications");
    expect((await screen.findAllByRole("link", { name: "Powiadomienia" })).length).toBeGreaterThan(0);
  });

  it("dodaje ntfy z tokenem i cichymi godzinami", async () => {
    const { calls } = mockApi();
    renderApp("/settings/notifications");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Dodaj kanał" }));
    const dialog = await screen.findByRole("dialog", { name: "Dodaj kanał powiadomień" });
    await user.selectOptions(within(dialog).getByLabelText("Rodzaj"), "ntfy");
    await user.type(within(dialog).getByLabelText("Nazwa"), "Telefon");
    await user.type(within(dialog).getByLabelText("Adres tematu"), "https://ntfy.sh/");
    await user.click(within(dialog).getByRole("button", { name: "Zapisz" }));
    expect(within(dialog).getByText("Podaj adres tematu, np. https://ntfy.sh/moj-temat.")).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Adres tematu"), "netpulse-xyz");
    await user.type(within(dialog).getByLabelText("Token dostępu (opcjonalnie)"), "tk_abc");
    await user.click(within(dialog).getByRole("checkbox", { name: /Nie wysyłaj w nocy/ }));
    expect(within(dialog).getByText(/strefie serwera NetPulse: zmienna TZ/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Zapisz" }));

    expect(await screen.findByText("Telefon")).toBeInTheDocument();
    const post = calls.find((c) => c.method === "POST" && c.path === "/api/notification-channels");
    expect(post?.body).toEqual({
      name: "Telefon",
      kind: "ntfy",
      min_severity: "warning",
      notify_resolved: true,
      quiet_from: "22:00",
      quiet_to: "07:00",
      quiet_critical: true,
      url: "https://ntfy.sh/netpulse-xyz",
      secret: "tk_abc",
    });
    expect(screen.getByText("ntfy · https://ntfy.sh/… · od ostrzeżeń · z zakończeniami · cisza 22:00–07:00")).toBeInTheDocument();
  });

  it("dodaje e-mail: serwer SMTP, port z trybu szyfrowania i adresaci", async () => {
    const { calls } = mockApi();
    renderApp("/settings/notifications");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Dodaj kanał" }));
    const dialog = await screen.findByRole("dialog", { name: "Dodaj kanał powiadomień" });
    await user.selectOptions(within(dialog).getByLabelText("Rodzaj"), "email");
    await user.type(within(dialog).getByLabelText("Nazwa"), "Poczta");
    await user.click(within(dialog).getByRole("button", { name: "Zapisz" }));
    expect(within(dialog).getByText("Podaj serwer SMTP.")).toBeInTheDocument();
    expect(within(dialog).getByText("Podaj co najmniej jeden poprawny adres e-mail.")).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText("Serwer SMTP"), "smtp.gmail.com");
    await user.selectOptions(within(dialog).getByLabelText("Szyfrowanie"), "ssl");
    expect(within(dialog).getByLabelText("Port")).toHaveValue("465");
    await user.type(within(dialog).getByLabelText("Użytkownik (opcjonalnie)"), "ja@gmail.com");
    await user.type(within(dialog).getByLabelText("Hasło"), "abcd efgh");
    await user.type(within(dialog).getByLabelText("Adresaci"), "ja@gmail.com; dom@example.com");
    await user.click(within(dialog).getByRole("button", { name: "Zapisz" }));

    expect(await screen.findByText("Poczta")).toBeInTheDocument();
    const post = calls.find((c) => c.method === "POST" && c.path === "/api/notification-channels");
    expect(post?.body).toMatchObject({
      kind: "email",
      secret: "abcd efgh",
      email: { host: "smtp.gmail.com", port: 465, security: "ssl", username: "ja@gmail.com", sender: null, recipients: ["ja@gmail.com", "dom@example.com"] },
    });
    expect(post?.body).not.toHaveProperty("url");
  });

  it("edycja e-maila: hasło zostaje, chyba że zaznaczono usunięcie; czekające alerty widać przy kanale", async () => {
    const mail: NotificationChannel = {
      ...CHANNEL,
      name: "Poczta",
      kind: "email",
      url_hint: "smtp.gmail.com:587",
      has_secret: true,
      email: { host: "smtp.gmail.com", port: 587, security: "starttls", username: "ja@gmail.com", sender: null, recipients: ["ja@gmail.com"] },
      quiet_from: "22:00",
      quiet_to: "07:00",
      quiet_pending: 3,
    };
    const { calls } = mockApi({ channels: [mail] });
    renderApp("/settings/notifications");
    const user = userEvent.setup();
    expect(await screen.findByText("czeka: 3")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Edytuj Poczta" }));
    const dialog = await screen.findByRole("dialog", { name: "Edycja: Poczta" });
    expect(within(dialog).queryByLabelText("Rodzaj")).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText("Serwer SMTP")).toHaveValue("smtp.gmail.com");
    expect(within(dialog).getByLabelText("Od")).toHaveValue("22:00");
    await user.click(within(dialog).getByRole("button", { name: "Zapisz" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const body = calls.find((c) => c.method === "PATCH")?.body as Record<string, unknown>;
    expect(body).not.toHaveProperty("secret");
    expect(body).not.toHaveProperty("kind");
    expect(body.email).toEqual(mail.email);

    await user.click(await screen.findByRole("button", { name: "Edytuj Poczta" }));
    const again = await screen.findByRole("dialog", { name: "Edycja: Poczta" });
    await user.click(within(again).getByRole("checkbox", { name: "Usuń zapisane hasło" }));
    await user.click(within(again).getByRole("button", { name: "Zapisz" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(2));
    expect((calls.filter((c) => c.method === "PATCH")[1].body as Record<string, unknown>).secret).toBe("");
  });
});

describe("adres ntfy i adresaci e-maila", () => {
  it("ntfy wymaga nazwy tematu; adresy rozdziela przecinek, średnik albo spacja", () => {
    expect(isValidNtfyUrl("https://ntfy.sh/dom")).toBe(true);
    expect(isValidNtfyUrl("https://ntfy.sh/")).toBe(false);
    expect(isValidNtfyUrl("ntfy.sh/dom")).toBe(false);
    expect(parseRecipients(" a@x.pl, b@y.pl;c@z.pl  d@q.pl ")).toEqual(["a@x.pl", "b@y.pl", "c@z.pl", "d@q.pl"]);
  });
});
