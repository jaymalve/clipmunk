import { readdirSync, statSync } from "node:fs";
import path from "node:path";
// @ts-expect-error: a plain script that builds the app the daemon serves
import { buildStudioApp } from "../../scripts/studio-app.mjs";

/** Vitest global setup: the daemon serves the Studio from CLIPMUNK_STUDIO_DIR. It is rebuilt only
 * when a source file is newer than the last build, so most runs take no time here.
 */
const SOURCES = ["studio", "studio-app", "core", "compositor", "react", "bridge", "recorder"];
const newest = (dir: string): number =>
  readdirSync(dir, { withFileTypes: true }).reduce((latest, entry) => {
    const full = path.join(dir, entry.name);
    return Math.max(latest, entry.isDirectory() ? newest(full) : statSync(full).mtimeMs);
  }, 0);

export default async function setup() {
  if (process.env.CLIPMUNK_STUDIO_DIR) return;
  const out = path.resolve("node_modules/.cache/clipmunk/studio-app");
  const built = (() => {
    try {
      return statSync(path.join(out, "index.html")).mtimeMs;
    } catch {
      return 0;
    }
  })();
  const changed = Math.max(
    ...SOURCES.map((source) => newest(path.resolve("src", source))),
    statSync("scripts/studio-app.mjs").mtimeMs,
  );
  if (changed > built) await buildStudioApp(out);
  process.env.CLIPMUNK_STUDIO_DIR = out;
}
