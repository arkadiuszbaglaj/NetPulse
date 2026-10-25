import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { PasswordRequirements } from "../components/PasswordRequirements";
import { evaluatePassword } from "./password";
import { mockApi } from "../test/mockApi";
import { renderApp } from "../test/renderApp";

describe("ocena hasła", () => {
  const ok = (p: string) => evaluatePassword(p).results.filter((r) => r.ok).map((r) => r.rule.id);

  it("rozpoznaje poszczególne warunki", () => {
    expect(ok("")).toEqual([]);
    expect(ok("abcdefgh")).toEqual(["length", "lower"]);
    expect(ok("ABCDEFGH1")).toEqual(["length", "upper", "digit"]);
    expect(ok("zażółć!")).toEqual(["lower", "special"]); // polskie litery to litery, nie znaki specjalne
    expect(ok("Abcdefgh1!xy")).toEqual(["length", "recommended", "lower", "upper", "digit", "special"]);
  });

  it("siła rośnie z długością i różnorodnością", () => {
    expect(evaluatePassword("").strength).toBe("none");
    expect(evaluatePassword("Ab1!").strength).toBe("weak"); // krótkie, choć różnorodne
    expect(evaluatePassword("abcdefgh").strength).toBe("weak");
    expect(evaluatePassword("abcdefG1").strength).toBe("fair");
    expect(evaluatePassword("abcdefG1!").strength).toBe("good");
    expect(evaluatePassword("kon-zjadl-zielone-jablko").strength).toBe("strong"); // długie hasło z samych słów
    expect(evaluatePassword("Abcdefgh1!xy").strength).toBe("strong");
  });
});

function Harness() {
  const [p, setP] = useState("");
  return (
    <>
      <input aria-label="hasło" value={p} onChange={(e) => setP(e.target.value)} />
      <PasswordRequirements id="req" password={p} />
    </>
  );
}

describe("PasswordRequirements", () => {
  it("pokazuje spełnione i niespełnione warunki tekstem, nie tylko kolorem", async () => {
    render(<Harness />);
    const list = screen.getByRole("list", { name: "Wymagania dla hasła" });
    expect(within(list).getAllByText("niespełnione")).toHaveLength(6);
    expect(screen.getByText("Wpisz hasło")).toBeInTheDocument();

    await userEvent.setup().type(screen.getByLabelText("hasło"), "Abcdefg1");
    const length = within(list).getByText("Co najmniej 8 znaków (wymagane)").closest("li")!;
    expect(within(length).getByText("spełnione")).toBeInTheDocument();
    const special = within(list).getByText("Znak specjalny").closest("li")!;
    expect(within(special).getByText("niespełnione")).toBeInTheDocument();
    expect(screen.getByText("Średnie")).toBeInTheDocument();
  });
});

describe("formularze", () => {
  it("kreator pierwszego konta pokazuje wymagania pod hasłem", async () => {
    mockApi({ setupRequired: true });
    renderApp();
    expect(await screen.findByRole("list", { name: "Wymagania dla hasła" })).toBeInTheDocument();
    expect(screen.getByLabelText("Hasło")).toHaveAttribute("aria-describedby", "password-rules");
  });

  it("ekran logowania nie pokazuje wymagań", async () => {
    mockApi({ authenticated: false });
    renderApp();
    expect(await screen.findByLabelText("Hasło")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Wymagania dla hasła" })).not.toBeInTheDocument();
  });

  it("Ustawienia → Konto pokazuje wymagania dla nowego hasła", async () => {
    mockApi();
    renderApp("/settings/account");
    expect(await screen.findByRole("list", { name: "Wymagania dla hasła" })).toBeInTheDocument();
  });
});
