/** Czy widgety są pokazywane na publicznym pulpicie (bez logowania) – wtedy bez linków do stron panelu. */
import { createContext, useContext } from "react";

export const PublicModeContext = createContext(false);

/** Linki do stron szczegółów (urządzenie, port, klient) – tylko w zalogowanym panelu. */
export function useDetailLinks(): boolean {
  return !useContext(PublicModeContext);
}
