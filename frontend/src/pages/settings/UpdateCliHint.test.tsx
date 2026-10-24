import { render, screen } from "@testing-library/react";
import { UPDATE_COMMAND, UpdateCliHint } from "./UpdateCliHint";

describe("blok „Aktualizacja z terminala”", () => {
  it("pokazuje komendę do wpisania na serwerze", () => {
    render(<UpdateCliHint />);
    expect(screen.getByRole("region", { name: "Aktualizacja z terminala" })).toBeInTheDocument();
    expect(UPDATE_COMMAND).toBe("netpulse update");
    expect(screen.getByText("netpulse update")).toHaveClass("select-all"); // zaznacza się jednym kliknięciem
    expect(screen.getByText(/netpulse cleanup/)).toBeInTheDocument();
  });
});
