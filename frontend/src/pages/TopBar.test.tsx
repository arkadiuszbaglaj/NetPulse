import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockApi } from "../test/mockApi";
import { renderApp } from "../test/renderApp";

// Na telefonie (< 640 px) motyw i interwał odświeżania są w menu konta (0.76.1); jsdom nie liczy media queries,
// więc sprawdzamy samo menu – na szerokim ekranie tę część chowa `sm:hidden`.
describe("pasek górny – menu konta", () => {
  it("zmienia interwał odświeżania i motyw z menu konta", async () => {
    mockApi();
    renderApp();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Menu konta" }));
    const menu = screen.getByRole("menu", { name: "Menu konta" });

    await user.click(within(menu).getByRole("menuitemradio", { name: "co 1 min" }));
    expect(screen.queryByRole("menu", { name: "Menu konta" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Automatyczne odświeżanie: co 1 min" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Menu konta" }));
    const again = screen.getByRole("menu", { name: "Menu konta" });
    expect(within(again).getByRole("menuitemradio", { name: "co 1 min" })).toHaveAttribute("aria-checked", "true");
    await user.click(within(again).getByRole("menuitem", { name: "Motyw: według systemu" }));
    expect(within(again).getByRole("menuitem", { name: "Motyw: jasny" })).toBeInTheDocument();
  });
});
