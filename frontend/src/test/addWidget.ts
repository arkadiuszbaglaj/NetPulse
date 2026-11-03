/** Okno „Dodaj widget” od 0.44.0: typy widgetów do pełnego edytora są w grupie „Własny”. */
import { screen, within } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";

export async function customWidgets(user: UserEvent): Promise<HTMLElement> {
  const dialog = await screen.findByRole("dialog", { name: "Dodaj widget" });
  await user.click(within(dialog).getByRole("button", { name: /^Własny\s*\d/ }));
  return dialog;
}
