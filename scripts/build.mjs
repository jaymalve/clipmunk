// Builds dist/: browser entry points in one pass (so they share one copy of the scene
// context), the CLI, and type declarations. Run: node scripts/build.mjs
import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { build } from "vite";
import { buildStudioApp } from "./studio-app.mjs";

const root = new URL("..", import.meta.url).pathname;
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const shared = { root, configFile: false, logLevel: "warn", define: { __CLIPMUNK_VERSION__: JSON.stringify(version) } };
rmSync(new URL("../dist", import.meta.url), { recursive: true, force: true });

await build({
  ...shared,
  build: {
    outDir: "dist",
    emptyOutDir: false,
    minify: false,
    target: "es2022",
    lib: {
      entry: {
        index: "src/index.ts",
        core: "src/core/index.ts",
        studio: "src/studio/index.ts",
        recorder: "src/recorder/index.ts",
      },
      formats: ["es"],
    },
    rollupOptions: {
      external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime", "zod", "mediabunny"],
      output: { chunkFileNames: "chunks/[name]-[hash].js" },
    },
  },
});
await build({
  ...shared,
  build: {
    outDir: "dist",
    emptyOutDir: false,
    minify: false,
    target: "node22",
    lib: {
      entry: { cli: "src/cli/main.ts", vite: "src/plugins/vite.ts", next: "src/plugins/next.ts" },
      formats: ["es"],
    },
    rollupOptions: { external: [/^node:/, "playwright", "zod"], output: { chunkFileNames: "chunks/[name]-[hash].js" } },
  },
});
// The webpack loader behind clipmunk/next, as CommonJS, which every webpack version loads.
await build({
  ...shared,
  build: {
    outDir: "dist",
    emptyOutDir: false,
    minify: false,
    target: "node22",
    lib: {
      entry: { "next-loader": "src/plugins/next-loader.ts" },
      formats: ["cjs"],
      fileName: () => "next-loader.cjs",
    },
    rollupOptions: { external: [/^node:/, "zod"], output: { exports: "default" } },
  },
});
// The standalone Studio the daemon serves: a static app with its own copy of React.
await buildStudioApp(new URL("../dist/studio-app", import.meta.url).pathname, { version });
const cli = new URL("../dist/cli.js", import.meta.url);
writeFileSync(cli, `#!/usr/bin/env node\n${readFileSync(cli, "utf8")}`);
chmodSync(cli, 0o755);
execFileSync("npx", ["tsc", "-p", "tsconfig.build.json"], { cwd: root, stdio: "inherit" });
console.log("Built dist/");
