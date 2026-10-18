import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const api = process.env.NORTHBOT_API ?? "http://localhost:3000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: api, changeOrigin: true, ws: true, rewrite: (p) => p.replace(/^\/api/, "") },
    },
  },
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    exclude: ["e2e/**", "node_modules/**"],
  },
});
