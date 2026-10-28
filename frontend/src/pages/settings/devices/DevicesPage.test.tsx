import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DEVICE, mockApi } from "../../../test/mockApi";
import { renderApp } from "../../../test/renderApp";

const SECOND = { ...DEVICE, id: 2, name: "USW Lite 8 PoE", host: "192.168.1.2", kind: "switch", status: "down", last_error: "timeout" };

async function openPage(devices = [DEVICE, SECOND]) {
  const user = userEvent.setup();
  const api = mockApi({ devices });
  renderApp("/settings/devices");
  await screen.findByRole("heading", { name: "Urządzenia" });
  return { user, ...api };
}

const lastCall = (calls: { method: string; path: string; body: unknown }[], method: string, path: string) =>
  [...calls].reverse().find((c) => c.method === method && c.path === path);

describe("lista urządzeń", () => {
  it("pokazuje urządzenia ze statusem, adresem i wersją SNMP", async () => {
    await openPage();
    expect(await screen.findByText("UCG Ultra")).toBeInTheDocument();
    expect(screen.getByText(/192\.168\.1\.1:161 · Router · SNMP 2c · unifi/)).toBeInTheDocument();
    expect(screen.getByText("USW Lite 8 PoE")).toBeInTheDocument();
    expect(screen.getByText("brak odpowiedzi")).toBeInTheDocument();
  });

  it("oznacza urządzenie z fabrycznym community SNMP", async () => {
    await openPage([{ ...DEVICE, default_community: true }, SECOND]);
    const row = (await screen.findByText("UCG Ultra")).closest("li") as HTMLElement;
    expect(within(row).getByText("community public")).toBeInTheDocument();
    const other = screen.getByText("USW Lite 8 PoE").closest("li") as HTMLElement;
    expect(within(other).queryByText("community public")).not.toBeInTheDocument();
  });

  it("przy pustej liście zaprasza do dodania urządzenia", async () => {
    await openPage([]);
    expect(await screen.findByText("Nie dodano jeszcze urządzeń")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dodaj urządzenie" })).toBeInTheDocument();
  });

  it("przełącznik wyłącza odpytywanie urządzenia", async () => {
    const { user, calls } = await openPage();
    const toggle = await screen.findByRole("switch", { name: /UCG Ultra/ });
    expect(toggle).toBeChecked();
    await user.click(toggle);
    expect(lastCall(calls, "PATCH", "/api/devices/1")?.body).toEqual({ enabled: false });
    expect(await screen.findByText("wyłączone")).toBeInTheDocument();
  });

  it("test SNMP zapisanego urządzenia pokazuje, co wykryto", async () => {
    const { user, calls } = await openPage();
    await user.click(await screen.findByRole("button", { name: "Testuj UCG Ultra" }));
    expect(await screen.findByText("Połączenie działa")).toBeInTheDocument();
    expect(screen.getByText(/Wykryto: Ubiquiti UniFi Switch \(switch\)/)).toBeInTheDocument();
    expect(screen.getByText(/porty: 2/)).toBeInTheDocument(); // port „lo” jest ukryty
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/devices/1/probe")).toBe(true);
    await user.click(screen.getByRole("button", { name: "Ukryj wynik" }));
    expect(screen.queryByText("Połączenie działa")).not.toBeInTheDocument();
  });

  it("test SNMP pokazuje błąd serwera", async () => {
    const { user, state } = await openPage();
    state.overrides["POST /api/devices/1/probe"] = {
      status: 422,
      body: { detail: "Brak odpowiedzi SNMP z 192.168.1.1: timeout" },
    };
    await user.click(await screen.findByRole("button", { name: "Testuj UCG Ultra" }));
    expect(await screen.findByText(/Brak odpowiedzi SNMP z 192\.168\.1\.1/)).toBeInTheDocument();
  });
});

describe("dodawanie urządzenia", () => {
  async function openAddDialog() {
    const ctx = await openPage([]);
    await ctx.user.click(await screen.findByRole("button", { name: "Dodaj urządzenie" }));
    const dialog = await screen.findByRole("dialog", { name: "Nowe urządzenie" });
    return { ...ctx, dialog };
  }

  it("waliduje pola przed wysłaniem", async () => {
    const { user, calls, dialog } = await openAddDialog();
    await user.click(within(dialog).getByRole("button", { name: "Zapisz" }));
    expect(await within(dialog).findByText("Podaj nazwę urządzenia.")).toBeInTheDocument();
    expect(within(dialog).getByText("Podaj adres IP albo nazwę hosta.")).toBeInTheDocument();
    expect(calls.some((c) => c.method === "POST" && c.path.startsWith("/api/devices"))).toBe(false);
    expect(within(dialog).getByLabelText("Nazwa")).toHaveAttribute("aria-invalid", "true");
  });

  it("testuje połączenie danymi z formularza i pokazuje wynik", async () => {
    const { user, calls, dialog } = await openAddDialog();
    await user.type(within(dialog).getByLabelText("Nazwa"), "Switch");
    await user.type(within(dialog).getByLabelText("Adres IP lub nazwa hosta"), "192.168.1.2");
    await user.click(within(dialog).getByRole("button", { name: "Testuj połączenie" }));
    expect(await within(dialog).findByText("Połączenie działa")).toBeInTheDocument();
    expect(lastCall(calls, "POST", "/api/probe")?.body).toEqual({
      host: "192.168.1.2",
      port: 161,
      driver: "auto",
      snmp_version: "2c",
      community: "public",
    });
  });

  it("zapisuje urządzenie i zamyka okno; lista się odświeża", async () => {
    const { user, calls, dialog } = await openAddDialog();
    await user.type(within(dialog).getByLabelText("Nazwa"), "Switch");
    await user.type(within(dialog).getByLabelText("Adres IP lub nazwa hosta"), "192.168.1.2");
    await user.click(within(dialog).getByRole("button", { name: "Zapisz" }));
    expect(await screen.findByText("Switch")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(lastCall(calls, "POST", "/api/devices")?.body).toMatchObject({ name: "Switch", host: "192.168.1.2", community: "public" });
  });

  it("po nieudanym teście przy zapisie pozwala zapisać bez testu", async () => {
    const user = userEvent.setup();
    const { calls, state } = mockApi({ devices: [] });
    renderApp("/settings/devices");
    await user.click(await screen.findByRole("button", { name: "Dodaj urządzenie" }));
    const dialog = await screen.findByRole("dialog");
    state.overrides["POST /api/devices"] = { status: 422, body: { detail: "Brak odpowiedzi SNMP z 192.168.1.9: timeout" } };

    await user.type(within(dialog).getByLabelText("Nazwa"), "Garaż");
    await user.type(within(dialog).getByLabelText("Adres IP lub nazwa hosta"), "192.168.1.9");
    await user.click(within(dialog).getByRole("button", { name: "Zapisz" }));
    expect(await within(dialog).findByText(/Brak odpowiedzi SNMP z 192\.168\.1\.9/)).toBeInTheDocument();

    delete state.overrides["POST /api/devices"];
    await user.click(within(dialog).getByRole("button", { name: "Zapisz bez testu" }));
    expect(await screen.findByText("Garaż")).toBeInTheDocument();
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/devices?probe=false")).toBe(true);
  });

  it("pokazuje komunikat serwera o duplikacie", async () => {
    const user = userEvent.setup();
    mockApi({ devices: [DEVICE] });
    renderApp("/settings/devices");
    await user.click(await screen.findByRole("button", { name: "Dodaj urządzenie" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Nazwa"), "Drugi router");
    await user.type(within(dialog).getByLabelText("Adres IP lub nazwa hosta"), "192.168.1.1");
    await user.click(within(dialog).getByRole("button", { name: "Zapisz" }));
    expect(await within(dialog).findByText("Urządzenie 192.168.1.1 już jest dodane")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Zapisz bez testu" })).not.toBeInTheDocument();
  });

  it("SNMP v3 pokazuje pola v3 zamiast community i wysyła je w żądaniu", async () => {
    const { user, calls, dialog } = await openAddDialog();
    await user.selectOptions(within(dialog).getByLabelText("Wersja SNMP"), "3");
    expect(within(dialog).queryByLabelText("Community")).not.toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Nazwa"), "Router v3");
    await user.type(within(dialog).getByLabelText("Adres IP lub nazwa hosta"), "192.168.1.1");
    await user.type(within(dialog).getByLabelText("Użytkownik SNMPv3"), "monitor");
    await user.selectOptions(within(dialog).getByLabelText("Protokół uwierzytelniania"), "SHA");
    await user.type(within(dialog).getByLabelText("Hasło uwierzytelniania"), "authklucz1");
    await user.selectOptions(within(dialog).getByLabelText("Protokół szyfrowania"), "AES");
    await user.type(within(dialog).getByLabelText("Hasło szyfrowania"), "privklucz1");
    await user.click(within(dialog).getByRole("button", { name: "Zapisz" }));
    await screen.findByText("Router v3");
    expect(lastCall(calls, "POST", "/api/devices")?.body).toEqual({
      name: "Router v3",
      host: "192.168.1.1",
      port: 161,
      driver: "auto",
      snmp_version: "3",
      v3_username: "monitor",
      v3_auth_protocol: "SHA",
      v3_auth_key: "authklucz1",
      v3_priv_protocol: "AES",
      v3_priv_key: "privklucz1",
    });
  });

  it("Escape i przycisk Anuluj zamykają okno bez zapisu", async () => {
    const { user, calls, dialog } = await openAddDialog();
    await user.type(within(dialog).getByLabelText("Nazwa"), "Porzucone");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Dodaj urządzenie" }));
    await user.click(await screen.findByRole("button", { name: "Anuluj" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(calls.some((c) => c.method === "POST" && c.path.startsWith("/api/devices"))).toBe(false);
  });
});

describe("edycja urządzenia", () => {
  async function openEdit() {
    const ctx = await openPage();
    await ctx.user.click(await screen.findByRole("button", { name: "Edytuj UCG Ultra" }));
    const dialog = await screen.findByRole("dialog", { name: "Edycja: UCG Ultra" });
    return { ...ctx, dialog };
  }

  it("wypełnia formularz bez ujawniania community", async () => {
    const { dialog } = await openEdit();
    expect(within(dialog).getByLabelText("Nazwa")).toHaveValue("UCG Ultra");
    expect(within(dialog).getByLabelText("Adres IP lub nazwa hosta")).toHaveValue("192.168.1.1");
    expect(within(dialog).getByLabelText("Community")).toHaveValue("");
    expect(within(dialog).getByText("Pozostaw puste, żeby zachować zapisane")).toBeInTheDocument();
  });

  it("wysyła tylko zmienione pola", async () => {
    const { user, calls, dialog } = await openEdit();
    const name = within(dialog).getByLabelText("Nazwa");
    await user.clear(name);
    await user.type(name, "Router główny");
    await user.click(within(dialog).getByRole("button", { name: "Zapisz" }));
    expect(await screen.findByText("Router główny")).toBeInTheDocument();
    expect(lastCall(calls, "PATCH", "/api/devices/1")?.body).toEqual({ name: "Router główny" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("bez zmian nie wysyła żądania", async () => {
    const { user, calls, dialog } = await openEdit();
    await user.click(within(dialog).getByRole("button", { name: "Zapisz" }));
    expect(await within(dialog).findByText("Nic nie zmieniono.")).toBeInTheDocument();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("nowe community trafia do żądania", async () => {
    const { user, calls, dialog } = await openEdit();
    await user.type(within(dialog).getByLabelText("Community"), "nowe-community");
    await user.click(within(dialog).getByRole("button", { name: "Zapisz" }));
    await screen.findByText("UCG Ultra");
    expect(lastCall(calls, "PATCH", "/api/devices/1")?.body).toEqual({ community: "nowe-community" });
  });
});

describe("usuwanie urządzenia", () => {
  it("pyta o potwierdzenie i usuwa po zgodzie", async () => {
    const { user, calls } = await openPage();
    await user.click(await screen.findByRole("button", { name: "Usuń USW Lite 8 PoE" }));
    const dialog = await screen.findByRole("dialog", { name: "Usunąć urządzenie?" });
    expect(within(dialog).getByText(/USW Lite 8 PoE.*razem z historią metryk/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Anuluj" })).toHaveFocus(); // bezpieczna domyślna akcja
    await user.click(within(dialog).getByRole("button", { name: "Usuń" }));
    expect(await screen.findByText("UCG Ultra")).toBeInTheDocument();
    expect(screen.queryByText("USW Lite 8 PoE")).not.toBeInTheDocument();
    expect(calls.some((c) => c.method === "DELETE" && c.path === "/api/devices/2")).toBe(true);
  });

  it("Anuluj nie usuwa", async () => {
    const { user, calls } = await openPage();
    await user.click(await screen.findByRole("button", { name: "Usuń UCG Ultra" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Anuluj" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(screen.getByText("UCG Ultra")).toBeInTheDocument();
  });
});

describe("ustawienia odświeżania", () => {
  it("zmiana domyślnego interwału i zakresu zapisuje wybór", async () => {
    const user = userEvent.setup();
    mockApi();
    renderApp("/settings/refresh");
    await screen.findByRole("heading", { name: "Odświeżanie" });
    await user.selectOptions(screen.getByLabelText("Automatyczne odświeżanie"), "co 10 s");
    await user.selectOptions(screen.getByLabelText("Domyślny zakres czasu wykresów"), "24 godz.");
    expect(localStorage.getItem("netpulse.refresh")).toBe("10");
    expect(localStorage.getItem("netpulse.range")).toBe("1440");
    expect(await screen.findByText(/Urządzenia są odpytywane co 30 s/)).toBeInTheDocument();
  });
});
