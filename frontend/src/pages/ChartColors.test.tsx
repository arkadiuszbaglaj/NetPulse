import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { autoColor, COLOR_INDEXES, toggleMetric } from "../lib/layout";
import { mockApi } from "../test/mockApi";
import { renderApp } from "../test/renderApp";

describe("kolory wykresów", () => {
  it("paleta ma 8 kolorów, a kolejne serie dostają kolejne wolne", () => {
    expect(COLOR_INDEXES).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect([0, 3, 4, 7, 8].map(autoColor)).toEqual([1, 4, 5, 8, 1]);
    // Kolory 1–4 zajęte (te same jednostki) → piąta seria dostaje kolor 5
    const four = [
      { key: "rx_bps", color: 1 as const },
      { key: "tx_bps", color: 2 as const },
      { key: "in_bps", color: 3 as const },
      { key: "out_bps", color: 4 as const },
    ];
    expect(toggleMetric(four, "read_bps", true).at(-1)).toEqual({ key: "read_bps", color: 5 });
  });

  it("edytor pokazuje 8 kolorów z nazwami", async () => {
    mockApi();
    renderApp();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edytuj pulpit" }));
    await user.click(screen.getByRole("button", { name: "Dodaj widget" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Dodaj widget" })).getByRole("button", { name: /Wykres/ }));
    const form = await screen.findByRole("dialog", { name: "Nowy wykres" });
    const group = within(form).getAllByRole("group", { name: /^Kolor:/ })[0];
    const buttons = within(group).getAllByRole("button");
    expect(buttons).toHaveLength(8);
    expect(buttons[4]).toHaveAccessibleName("Kolor 5");
    expect(buttons[4]).toHaveAttribute("title", "koralowy");
    await user.click(buttons[6]);
    expect(buttons[6]).toHaveAttribute("aria-pressed", "true");
  });
});
