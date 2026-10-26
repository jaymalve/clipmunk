import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  EDIT_FILE,
  MANIFEST_FILE,
  type Manifest,
  type ManifestEntry,
  ManifestSchema,
  parseEvents,
  SEQUENCES_DIR,
  TakeEventSchema,
} from "../core";
import { importGraph } from "./imports";
import { discoverScenes } from "./operations";
import { readSequence } from "./sequences";
import { readText, resolveInside, sha256, writeText } from "./services";
import { loadTake, takeDir } from "./takes";

/** The export manifest, `.clipmunk/manifest.json` (committed): after every export, each clip's
 * source files with their hashes. A scene's are its recipe and everything its component imports;
 * a take's are its edit and the files its elements came from (`el.src` in the log, with their
 * imports); a sequence's are its file and its clips'.
 */
export type ClipRef = { kind: "scene" | "take" | "sequence"; id: string };
export const clipKey = (clip: ClipRef) => `${clip.kind}:${clip.id}`;

export async function clipSources(root: string, clip: ClipRef): Promise<string[]> {
  if (clip.kind === "scene") {
    const scene = (await discoverScenes({ root }, clip.id)).scenes.find((candidate) => candidate.id === clip.id);
    if (!scene) return [];
    return [...new Set([scene.source, ...(await importGraph(root, [scene.binding]))])].sort();
  }
  if (clip.kind === "take") {
    const loaded = await loadTake(root, clip.id);
    if (!loaded.ok) return [];
    const log = (await readText(root, `${takeDir(clip.id)}/${loaded.data.take.source.events.file}`)) ?? "";
    const shown = new Set<string>();
    for (const event of parseEvents(log, TakeEventSchema)) if ("el" in event && event.el?.src) shown.add(event.el.src);
    return [...new Set([`${takeDir(clip.id)}/${EDIT_FILE}`, ...(await importGraph(root, [...shown]))])].sort();
  }
  const sequence = await readSequence(clip.id, { root });
  if (!sequence.ok) return [];
  const files = new Set([`${SEQUENCES_DIR}/${clip.id}.sequence.json`]);
  for (const item of sequence.data.items) for (const file of await clipSources(root, item.clip)) files.add(file);
  return [...files].sort();
}

export async function readManifest(root: string): Promise<Manifest> {
  try {
    const parsed = ManifestSchema.safeParse(JSON.parse((await readText(root, MANIFEST_FILE)) ?? "null"));
    if (parsed.success) return parsed.data;
  } catch {
    // An unreadable manifest starts over; it is rebuilt by the next exports.
  }
  return { version: 1, clips: {} };
}

/** Each file's hash now, as the manifest stores it; a missing file has none. */
export async function hashFiles(root: string, files: readonly string[]): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const file of files) {
    const content = await readFile(await resolveInside(root, file)).catch(() => undefined);
    if (content) hashes[file] = sha256(content);
  }
  return hashes;
}

// One update at a time in this process, so two exports finishing together both land.
let queue: Promise<unknown> = Promise.resolve();

/** Record a finished export of `clip`. Never fails the export: a manifest problem is only reported. */
export function recordExport(root: string, clip: ClipRef, outputs: readonly string[]): Promise<ManifestEntry> {
  const run = queue.then(async () => {
    const entry: ManifestEntry = {
      files: await hashFiles(root, await clipSources(root, clip)),
      exportedAt: new Date().toISOString(),
      outputs: outputs.map((output) => (path.isAbsolute(output) ? path.relative(root, output) : output)),
    };
    const manifest = await readManifest(root);
    manifest.clips[clipKey(clip)] = entry;
    const clips = Object.fromEntries(Object.entries(manifest.clips).sort(([a], [b]) => a.localeCompare(b)));
    await writeText(root, MANIFEST_FILE, `${JSON.stringify({ version: 1, clips }, null, 2)}\n`);
    return entry;
  });
  queue = run.catch(() => {});
  return run;
}
