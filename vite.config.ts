import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import checker from "vite-plugin-checker";

export default defineConfig({
  plugins: [react(), checker({ typescript: true })],
  server: {
    port: 5173,
    proxy: {
      "/api/storage": "http://localhost:8787",
      "/media": "http://localhost:8787",
    },
  },
  build: {
    sourcemap: true,
  },
});
