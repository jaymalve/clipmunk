import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultEdit } from "../core";
import { applyPresetToTake, listPresets, loadTake, savePreset } from "./index";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const ID = "take-20261005-142233";
async function project(config?: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "clipmunk-presets-"));
  roots.push(root);
  const dir = path.join(root, ".clipmunk/takes", ID);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "take.json"),
    JSON.stringify({
      version: 1,
      id: ID,
      title: "Demo",
      createdAt: "2026-10-05T14:22:33.000Z",
      source: {
        width: 1280,
        height: 720,
        dpr: 2,
        durationMs: 5000,
        background: "#fff",
        screen: { file: "screen.webm", offsetMs: 0, latencyMs: 40, width: 2560, height: 1440 },
        events: { file: "events.jsonl", count: 0 },
      },
    }),
  );
  const edit = { ...defaultEdit(5000), trim: { startMs: 1000, endMs: 4000 } };
  await writeFile(path.join(dir, "edit.json"), JSON.stringify({ version: 1, edit }));
  if (config !== undefined) await writeFile(path.join(root, "clipmunk.config.json"), config);
  return { root, config: () => readFile(path.join(root, "clipmunk.config.json"), "utf8") };
}
const QUIET = { title: "Quiet", music: null, edit: { cursor: { size: 2 } } };

describe("saving presets", () => {
  it("adds a preset and leaves the rest of the file as it was", async () => {
    const original = `{
    "version": 1,
    "brand": { "backdrop": "#2B2117" },
    "redact": [".client-email"],
    "presets": {
        "launch": { "music": { "style": "lofi" } }
    }
}
`;
    const { root, config } = await project(original);
    const saved = await savePreset(root, { name: "quiet", preset: QUIET });
    if (!saved.ok) throw new Error(JSON.stringify(saved.issues));
    const written = await config();
    // Four-space indentation kept, keys in their order, the new preset last.
    expect(Object.keys(JSON.parse(written))).toEqual(["version", "brand", "redact", "presets"]);
    expect(Object.keys(JSON.parse(written).presets)).toEqual(["launch", "quiet"]);
    expect(written).toContain('\n    "brand": {\n        "backdrop": "#2B2117"');
    expect(JSON.parse(written).presets.quiet).toEqual(QUIET);
  });

  it("keeps tabs, and creates the file when there is none", async () => {
    const tabs = await project('{\n\t"version": 1\n}\n');
    await savePreset(tabs.root, { name: "quiet", preset: QUIET });
    expect(await tabs.config()).toMatch(/^\{\n\t"version": 1,\n\t"presets": \{\n\t\t"quiet"/);
    const none = await project();
    const saved = await savePreset(none.root, { name: "quiet", preset: QUIET });
    expect(saved.ok).toBe(true);
    expect(JSON.parse(await none.config())).toEqual({ version: 1, presets: { quiet: QUIET } });
  });

  it("replaces a preset only when asked, keeping its place", async () => {
    const { root, config } = await project(
      JSON.stringify({ version: 1, presets: { a: { music: null }, b: { music: null } } }),
    );
    const refused = await savePreset(root, { name: "a", preset: QUIET });
    expect(refused.ok || refused.issues[0]!.code).toBe("preset-exists");
    expect(await savePreset(root, { name: "a", preset: QUIET, replace: true })).toMatchObject({ ok: true });
    const written = JSON.parse(await config());
    expect(Object.keys(written.presets)).toEqual(["a", "b"]);
    expect(written.presets.a).toEqual(QUIET);
  });

  it("refuses a bad name, a bad preset and a broken config, and writes nothing", async () => {
    const { root, config } = await project('{ "version": 1, "brand": { "backdrop": "beige" } }');
    expect((await savePreset(root, { name: "Quiet One", preset: QUIET })).ok).toBe(false);
    const bad = await savePreset(root, { name: "quiet", preset: { edit: { zoom: { mode: "manual", tracks: [] } } } });
    expect(bad.ok || bad.issues[0]!.code).toBe("invalid-preset");
    const broken = await savePreset(root, { name: "quiet", preset: QUIET });
    expect(broken.ok || broken.issues[0]!.path).toBe("clipmunk.config.json: brand.backdrop");
    expect(await config()).toBe('{ "version": 1, "brand": { "backdrop": "beige" } }');
  });

  it("saves the chosen parts of a take", async () => {
    const { root, config } = await project();
    const saved = await savePreset(root, { name: "from-take", fromTake: ID, fields: ["cursor", "zoom"] });
    if (!saved.ok) throw new Error(JSON.stringify(saved.issues));
    // Parts are written in the edit's own order, whatever order they were chosen in.
    expect(Object.keys(JSON.parse(await config()).presets["from-take"].edit)).toEqual(["zoom", "cursor"]);
    expect(saved.data.summary).toBe("zoom up to 2.2x");
  });
});

describe("applying presets", () => {
  it("changes only the preset's parts of a take's edit", async () => {
    const { root } = await project(JSON.stringify({ version: 1, presets: { quiet: QUIET } }));
    const before = await loadTake(root, ID);
    if (!before.ok) throw new Error(JSON.stringify(before.issues));
    const applied = await applyPresetToTake(root, ID, "quiet");
    if (!applied.ok) throw new Error(JSON.stringify(applied.issues));
    const { edit } = applied.data.take;
    expect(edit).toEqual({ ...before.data.take.edit, cursor: { ...before.data.take.edit.cursor, size: 2 } });
    const after = await loadTake(root, ID);
    expect(after.ok && after.data.revision).toBe(applied.data.revision);
  });

  it("names the presets there are when one is missing", async () => {
    const { root } = await project(JSON.stringify({ version: 1, presets: { quiet: QUIET, launch: {} } }));
    const missing = await applyPresetToTake(root, ID, "loud");
    expect(missing.ok || missing.issues[0]!.message).toBe(
      'No preset named "loud" in clipmunk.config.json. Presets: quiet, launch.',
    );
    const listed = await listPresets(root);
    expect(listed.ok && listed.data.presets.map((entry) => [entry.name, entry.summary])).toEqual([
      ["quiet", "no music"],
      ["launch", "no changes"],
    ]);
  });
});
