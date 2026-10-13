import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const src = (path: string) => fileURLToPath(new URL(`../../src/${path}`, import.meta.url));

// The example imports the package by its published name, resolved to source.
export default defineConfig({
  plugins: [react()],
  // The hero film's scenes are shot on the landing page's demo dashboard, which lives in site/demo.
  server: { fs: { allow: [".", fileURLToPath(new URL("../../site/demo", import.meta.url))] } },
  resolve: {
    alias: [
      { find: "clipmunk/recorder", replacement: src("recorder/index.ts") },
      { find: "clipmunk/studio", replacement: src("studio/index.ts") },
      { find: "clipmunk/core", replacement: src("core/index.ts") },
      { find: "clipmunk", replacement: src("index.ts") },
    ],
  },
});
