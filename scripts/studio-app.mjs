// Builds the standalone Studio (src/studio-app) into a static folder the daemon serves.
// Used by scripts/build.mjs for dist/studio-app, and by the studio test suite.
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));

export async function buildStudioApp(outDir, { version = "dev" } = {}) {
  const react = (await import("@vitejs/plugin-react")).default;
  // A production bundle whoever builds it: a test runner sets NODE_ENV=test, which would make
  // the React plugin emit development JSX that the bundled production React cannot run.
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    await bundle(outDir, version, react);
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
}

async function bundle(outDir, version, react) {
  await build({
    mode: "production",
    root: `${root}src/studio-app`,
    configFile: false,
    logLevel: "warn",
    base: "/",
    plugins: [react()],
    define: { __CLIPMUNK_VERSION__: JSON.stringify(version), "process.env.NODE_ENV": JSON.stringify("production") },
    build: { outDir, emptyOutDir: true, target: "es2022", sourcemap: false, chunkSizeWarningLimit: 4096 },
  });
}
