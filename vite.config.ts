import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "100.65.64.80",
    port: 5757,
    proxy: { "/api": "http://100.65.64.80:8787" },
  },
  preview: { host: "100.65.64.80", port: 5757 },
  build: { outDir: "dist" },
  // The deterministic full-deck/domain verification tests intentionally scan
  // thousands of records and can exceed Vitest's 5 s default under parallel CI.
  test: { testTimeout: 15_000 },
});
