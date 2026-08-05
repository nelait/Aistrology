import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
// The API server (see server/) runs separately on PORT (default 8787). In dev we
// proxy /api and /auth to it so the browser sees a single origin — which keeps
// OAuth redirects and session cookies simple.
const API_TARGET = process.env.API_TARGET ?? "http://localhost:8787";

export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist",
    sourcemap: false,
  },
  server: {
    proxy: {
      "/api": { target: API_TARGET, changeOrigin: true },
      "/auth": { target: API_TARGET, changeOrigin: true },
    },
  },
});
