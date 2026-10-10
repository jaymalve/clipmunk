import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getGuide } from "../core";
import { deleteSequence, listSequences, readSequence, writeSequence } from "./index";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function project() {
  const root = await mkdtemp(path.join(os.tmpdir(), "flick-sequences-"));
  roots.push(root);
  const guide = getGuide();
  const files: Record<string, string> = {
    "package.json": "{}",
    [guide.example.recipePath]: JSON.stringify(guide.example.recipe),
    [guide.example.componentPath]: guide.example.component,
    ".flick/takes/demo/take.json": "{}",
  };
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
  return root;
}
const sequence = (id: string, clips: [string, string][]) => ({ version: 1, id, title: "Launch", items: clips.map(([kind, clip]) => ({ clip: { kind, id: clip } })) });

describe("sequences on disk", () => {
  it("writes, lists, reads and deletes a sequence whose clips exist", async () => {
    const root = await project();
    const written = await writeSequence("launch", sequence("launch", [["scene", "page-survey"], ["take", "demo"]]), { root });
    expect(written.ok && written.data.items).toHaveLength(2);
    expect(JSON.parse(await readFile(path.join(root, "src/flick/sequences/launch.sequence.json"), "utf8")).fps).toBe(60);
    const listed = await listSequences({ root });
    expect(listed.ok && listed.data.sequences.map((entry) => entry.id)).toEqual(["launch"]);
    expect((await readSequence("launch", { root })).ok).toBe(true);
    expect((await deleteSequence("launch", { root })).ok).toBe(true);
    expect(await readSequence("launch", { root })).toMatchObject({ ok: false, issues: [{ code: "unknown-sequence" }] });
  });

  it("names the clip that does not exist, and refuses to save it", async () => {
    const root = await project();
    const missing = await writeSequence("launch", sequence("launch", [["scene", "page-survey"], ["take", "gone"], ["scene", "nope"]]), { root });
    expect(missing).toMatchObject({ ok: false, issues: [{ code: "unknown-clip", path: "items.1.clip" }, { code: "unknown-clip", path: "items.2.clip" }] });
    expect((await listSequences({ root })).ok && ((await listSequences({ root })) as { data: { sequences: unknown[] } }).data.sequences).toEqual([]);
  });

  it("reports hand-written files that are broken, misnamed or point nowhere", async () => {
    const root = await project();
    const dir = path.join(root, "src/flick/sequences");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "broken.sequence.json"), "{ nope");
    await writeFile(path.join(dir, "renamed.sequence.json"), JSON.stringify(sequence("other", [["scene", "page-survey"]])));
    await writeFile(path.join(dir, "stale.sequence.json"), JSON.stringify(sequence("stale", [["take", "deleted-take"]])));
    await writeFile(path.join(dir, "good.sequence.json"), JSON.stringify(sequence("good", [["scene", "page-survey"]])));
    const listed = await listSequences({ root });
    if (!listed.ok) throw new Error("failed");
    expect(listed.data.sequences.map((entry) => entry.id)).toEqual(["good"]);
    expect(listed.data.issues.map((issue) => issue.code).sort()).toEqual(["id-mismatch", "invalid-json", "unknown-clip"]);
    expect(await writeSequence("../escape", sequence("../escape", [["scene", "page-survey"]]), { root })).toMatchObject({ ok: false });
    expect(await writeSequence("launch", sequence("different", [["scene", "page-survey"]]), { root })).toMatchObject({ ok: false, issues: [{ code: "id-mismatch" }] });
  });
});
