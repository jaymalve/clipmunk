// Spike: the standalone Studio shell, on its own origin. Imports Studio pieces straight from src.
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL("./shell", import.meta.url)),
  plugins: [react()],
  server: { port: 4800, strictPort: true, host: "127.0.0.1", fs: { allow: [fileURLToPath(new URL("../..", import.meta.url))] } },
});
