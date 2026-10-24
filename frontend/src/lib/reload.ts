/** Przeładowanie strony po aktualizacji (osobny moduł, żeby dało się je podmienić w testach). */
export const RELOAD_DELAY_MS = 3000;

export function reloadPage(): void {
  window.location.reload();
}
