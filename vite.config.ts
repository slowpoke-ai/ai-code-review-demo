import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // proxy Anthropic API to avoid CORS in dev
  server: {
    proxy: {
      "/api/anthropic": {
        target: "https://api.anthropic.com",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/anthropic/, ""),
        headers: { "anthropic-version": "2023-06-01" },
      },
    },
  },
});