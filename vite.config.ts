import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "100.65.64.80",
    port: 5173,
    proxy: { "/api": "http://100.65.64.80:8787" },
  },
  preview: { host: "100.65.64.80" },
  build: { outDir: "dist" },
});
