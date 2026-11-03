/** Układ sprzed 0.42.0 (karty urządzeń, dwa wykresy) – w testach jako zapisany pulpit istniejącego użytkownika. */
import { SUMMARY_TILES, newChartConfig, type DashboardLayout } from "../lib/layout";

export const CLASSIC_LAYOUT: DashboardLayout = {
  version: 1,
  widgets: [
    { id: "podsumowanie", type: "summary", w: 12, h: 3, config: { tiles: [...SUMMARY_TILES] } },
    { id: "ruch-wan", type: "chart", w: 8, config: newChartConfig({ kind: "wan" }) },
    { id: "klienci-wifi", type: "chart", w: 4, config: newChartConfig({ kind: "wifi_total" }) },
    { id: "urzadzenia", type: "devices", w: 12, config: { kinds: null } },
  ],
};
