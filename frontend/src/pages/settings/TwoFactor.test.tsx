import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { groupSecret } from "../../components/TwoFactorCard";
import { USER, mockApi } from "../../test/mockApi";
import { renderApp } from "../../test/renderApp";

describe("logowanie dwuskładnikowe", () => {
  it("logowanie pyta o kod, gdy konto ma 2FA", async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({ authenticated: false, loginNeedsCode: true });
    renderApp();
    await user.type(await screen.findByLabelText("Login"), "admin");
    await user.type(screen.getByLabelText("Hasło"), "dlugie-haslo-1");
    await user.click(screen.getByRole("button", { name: "Zaloguj" }));

    const codeField = await screen.findByLabelText("Kod z aplikacji");
    expect(screen.queryByText("Podaj kod z aplikacji uwierzytelniającej")).toBeNull(); // to nie błąd, tylko drugi krok
    await user.type(codeField, "000000");
    await user.click(screen.getByRole("button", { name: "Zaloguj" }));
    expect(await screen.findByText("Nieprawidłowy kod")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Kod z aplikacji"), "123456");
    await user.click(screen.getByRole("button", { name: "Zaloguj" }));
    expect(await screen.findByRole("heading", { name: "Dashboard" })).toBeInTheDocument();
    const logins = calls.filter((c) => c.method === "POST" && c.path === "/api/auth/login");
    expect(logins.at(-1)?.body).toEqual({ username: "admin", password: "dlugie-haslo-1", code: "123456" });
  });

  it("włącza 2FA: hasło → kod QR → kod → kody zapasowe", async () => {
    const user = userEvent.setup();
    mockApi();
    renderApp("/settings/account");
    const card = (await screen.findByRole("heading", { name: "Logowanie dwuskładnikowe" })).closest("div.p-5") as HTMLElement;
    expect(within(card).getByText("wyłączone")).toBeInTheDocument();
    await user.click(within(card).getByRole("button", { name: "Włącz" }));

    await user.type(within(card).getByLabelText("Twoje hasło"), "zle");
    await user.click(within(card).getByRole("button", { name: "Dalej" }));
    expect(await within(card).findByText("Hasło jest nieprawidłowe")).toBeInTheDocument();
    await user.clear(within(card).getByLabelText("Twoje hasło"));
    await user.type(within(card).getByLabelText("Twoje hasło"), "haslo-testowe-1");
    await user.click(within(card).getByRole("button", { name: "Dalej" }));

    expect(await within(card).findByAltText("Kod QR do aplikacji uwierzytelniającej")).toBeInTheDocument();
    expect(within(card).getByText(groupSecret("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP"))).toBeInTheDocument();
    await user.type(within(card).getByLabelText("Kod z aplikacji (6 cyfr)"), "999999");
    await user.click(within(card).getByRole("button", { name: "Potwierdź i włącz" }));
    expect(await within(card).findByText(/Nieprawidłowy kod/)).toBeInTheDocument();
    await user.clear(within(card).getByLabelText("Kod z aplikacji (6 cyfr)"));
    await user.type(within(card).getByLabelText("Kod z aplikacji (6 cyfr)"), "123456");
    await user.click(within(card).getByRole("button", { name: "Potwierdź i włącz" }));

    const list = await within(card).findByRole("list", { name: "Kody zapasowe" });
    expect(within(list).getByText("abcd-efgh")).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: "Pobierz plik" })).toHaveAttribute("download", "uplinkview-kody-zapasowe.txt");
    await user.click(within(card).getByRole("button", { name: "Zapisałem kody" }));
    expect(await within(card).findByText("włączone")).toBeInTheDocument();
    expect(within(card).getByText(/Pozostałe kody zapasowe: 10/)).toBeInTheDocument();
  });

  it("wyłącza 2FA hasłem i kodem", async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({ totp: { enabled: true, pending: false, recovery_left: 2 } });
    renderApp("/settings/account");
    const card = (await screen.findByRole("heading", { name: "Logowanie dwuskładnikowe" })).closest("div.p-5") as HTMLElement;
    expect(await within(card).findByText("Zostało mało kodów zapasowych – wygeneruj nowe.")).toBeInTheDocument();
    await user.click(within(card).getByRole("button", { name: "Wyłącz" }));
    await user.type(within(card).getByLabelText("Twoje hasło"), "haslo-testowe-1");
    await user.type(within(card).getByLabelText("Kod z aplikacji"), "123456");
    await user.click(within(card).getByRole("button", { name: "Wyłącz" }));
    await waitFor(() => expect(calls.find((c) => c.path === "/api/auth/totp/disable")?.body).toEqual({ password: "haslo-testowe-1", code: "123456" }));
    expect(await within(card).findByText("wyłączone")).toBeInTheDocument();
  });

  it("administrator widzi 2FA na liście kont i może je wyłączyć", async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({ users: [USER, { ...USER, id: 2, username: "jan", role: "viewer", is_admin: false, totp_enabled: true }] });
    renderApp("/settings/users");
    const row = (await screen.findByText("jan")).closest("li") as HTMLElement;
    expect(within(row).getByText("2FA")).toBeInTheDocument();
    await user.click(within(row).getByRole("button", { name: "Edytuj jan" }));
    const dialog = await screen.findByRole("dialog", { name: "Konto jan" });
    await user.click(within(dialog).getByLabelText(/Wyłącz logowanie dwuskładnikowe/));
    await user.click(within(dialog).getByRole("button", { name: "Zapisz" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH" && c.path === "/api/users/2")?.body).toEqual({ reset_totp: true }));
  });
});
