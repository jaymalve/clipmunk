import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const src = (path: string) => fileURLToPath(new URL(`../../src/${path}`, import.meta.url));

// The example imports the package by its published name, resolved to source.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: "@flickjs/record/recorder", replacement: src("recorder/index.ts") },
      { find: "@flickjs/record/studio", replacement: src("studio/index.ts") },
      { find: "@flickjs/record/core", replacement: src("core/index.ts") },
      { find: "@flickjs/record", replacement: src("index.ts") },
    ],
  },
});
