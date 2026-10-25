import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Builds the standalone Studio once, for the suites that open it or export takes through it.
    globalSetup: ["tests/support/studio-app.ts"],
  },
});
