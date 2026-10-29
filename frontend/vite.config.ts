/// <reference types="vitest/config" />
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Podczas developmentu zapytania /api idą do backendu (albo do `npm run mock`).
// Bez changeOrigin – nagłówek Host zostaje zgodny z Origin przeglądarki (ochrona CSRF w API).
const API = process.env.NETPULSE_API ?? "http://127.0.0.1:8000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: { "/api": API, "/docs": API, "/openapi.json": API },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    // ECharts (~545 kB) to osobny plik ładowany dopiero z pierwszym wykresem – ostrzeżenie o rozmiarze nic tu nie wnosi
    chunkSizeWarningLimit: 600,
    rolldownOptions: {
      output: {
        // Biblioteki zmieniają się rzadko – osobny plik zostaje w pamięci przeglądarki po aktualizacji NetPulse.
        // Strony i ECharts są ładowane na żądanie (lazy w modules.tsx i przy wykresach).
        codeSplitting: {
          groups: [
            { name: "vendor", test: /node_modules[\/](react|react-dom|scheduler|react-router|@tanstack)[\/]/ },
            // Ikony jednym plikiem zamiast kilkudziesięciu mikroskopijnych (każda strona używa kilku)
            { name: "icons", test: /node_modules[\/]@tabler[\/]/ },
          ],
        },
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.tsx"],
    css: false,
  },
});
