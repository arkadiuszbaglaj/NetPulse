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
  build: { outDir: "dist", sourcemap: false },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
  },
});
