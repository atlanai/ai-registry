import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { mockServer } from "./mock/plugin.ts";

export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss(), mockServer()],
  build: {
    outDir: "dist",
    assetsDir: "assets",
    emptyOutDir: true,
    sourcemap: false,
    // The server's CSP allows only its own files, and one chunk needs no preload helper.
    modulePreload: { polyfill: false },
    reportCompressedSize: true,
  },
});
