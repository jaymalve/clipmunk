import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultEdit, PROJECT_FILE } from "../core";
import { initProject, loadTake, refreshStateFiles, saveTakeEdit, sha256 } from "./index";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const ID = "take-20261005-142233";
const record = {
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
};
async function project(files: { take: unknown; edit?: unknown }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "clipmunk-takes-"));
  roots.push(root);
  const dir = path.join(root, ".clipmunk/takes", ID);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "take.json"), `${JSON.stringify(files.take, null, 2)}\n`);
  if (files.edit !== undefined) await writeFile(path.join(dir, "edit.json"), JSON.stringify(files.edit));
  const read = (name: string) => readFile(path.join(dir, name), "utf8");
  return { root, dir, read };
}
const trimmed = { ...defaultEdit(5000), trim: { startMs: 1000, endMs: 4000 } };

describe("a take's two files", () => {
  it("takes the edit from edit.json, over one left in an older take.json", async () => {
    const { root } = await project({
      take: { ...record, edit: defaultEdit(5000) },
      edit: { version: 1, edit: trimmed },
    });
    const loaded = await loadTake(root, ID);
    expect(loaded.ok && loaded.data.take.edit.trim).toEqual({ startMs: 1000, endMs: 4000 });
  });

  it("reads an older take whose edit is still in take.json", async () => {
    const { root } = await project({ take: { ...record, edit: trimmed } });
    const loaded = await loadTake(root, ID);
    expect(loaded.ok && loaded.data.take.edit.trim).toEqual({ startMs: 1000, endMs: 4000 });
  });

  it("gives a take with no edit anywhere the default edit", async () => {
    const { root } = await project({ take: record });
    const loaded = await loadTake(root, ID);
    expect(loaded.ok && loaded.data.take.edit).toEqual(defaultEdit(5000));
  });

  it("saves to edit.json and never rewrites take.json", async () => {
    const { root, read } = await project({ take: { ...record, edit: defaultEdit(5000) } });
    const before = await read("take.json");
    const loaded = await loadTake(root, ID);
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
    const saved = await saveTakeEdit(root, ID, { edit: trimmed, title: "Demo", revision: loaded.data.revision });
    if (!saved.ok) throw new Error(JSON.stringify(saved.issues));
    expect(await read("take.json")).toBe(before);
    // An unchanged title is not copied into the edit file.
    expect(JSON.parse(await read("edit.json"))).toEqual({ version: 1, edit: trimmed });
    const again = await loadTake(root, ID);
    expect(again.ok && again.data).toEqual({ take: saved.data.take, revision: saved.data.revision });
  });

  it("renames a take in edit.json", async () => {
    const { root, read } = await project({ take: record });
    const loaded = await loadTake(root, ID);
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
    const saved = await saveTakeEdit(root, ID, { title: "Send an invoice", revision: loaded.data.revision });
    expect(saved.ok && saved.data.take.title).toBe("Send an invoice");
    expect(JSON.parse(await read("edit.json")).title).toBe("Send an invoice");
    expect(JSON.parse(await read("take.json")).title).toBe("Demo");
  });

  it("refuses a save when either file changed since it was read", async () => {
    const { root, dir } = await project({ take: record, edit: { version: 1, edit: trimmed } });
    for (const name of ["edit.json", "take.json"]) {
      const loaded = await loadTake(root, ID);
      if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
      const file = path.join(dir, name);
      await writeFile(file, `${await readFile(file, "utf8")} `);
      const saved = await saveTakeEdit(root, ID, { edit: trimmed, revision: loaded.data.revision });
      expect(saved.ok || saved.issues[0]!.code).toBe("stale-revision");
    }
  });

  it("names the file a problem is in", async () => {
    const bad = await project({
      take: record,
      edit: { version: 1, edit: { ...trimmed, trim: { startMs: 0, endMs: 9999 } } },
    });
    const loaded = await loadTake(bad.root, ID);
    expect(loaded.ok || loaded.issues[0]!.path).toBe(`.clipmunk/takes/${ID}/edit.json: edit.trim.endMs`);
    const broken = await project({ take: record, edit: "{" });
    await writeFile(path.join(broken.dir, "edit.json"), "{");
    const unreadable = await loadTake(broken.root, ID);
    expect(unreadable.ok || unreadable.issues[0]!.message).toBe(`.clipmunk/takes/${ID}/edit.json is not valid JSON.`);
  });
});

describe("state files of an older project", () => {
  const VITE = {
    "package.json": JSON.stringify({ dependencies: { react: "19", "react-dom": "19", vite: "8" } }),
    "index.html": '<script type="module" src="/src/main.jsx"></script>',
  };
  async function connected() {
    const root = await mkdtemp(path.join(os.tmpdir(), "clipmunk-state-"));
    roots.push(root);
    for (const [name, content] of Object.entries(VITE)) await writeFile(path.join(root, name), content);
    const init = await initProject({}, { root });
    if (!init.ok) throw new Error(JSON.stringify(init.issues));
    return root;
  }
  // What init wrote before edit.json existed.
  const OLD = `# Clipmunk: media, caches and local state stay out of git. Take edits (take.json) are kept.
exports/
audio/
cache/
daemon.json
takes/*/*
!takes/*/take.json
`;
  const pretendOld = async (root: string, gitignore: string) => {
    await writeFile(path.join(root, ".clipmunk/.gitignore"), gitignore);
    const file = JSON.parse(await readFile(path.join(root, PROJECT_FILE), "utf8"));
    file.files[".clipmunk/.gitignore"] = sha256(OLD);
    await writeFile(path.join(root, PROJECT_FILE), JSON.stringify(file));
  };

  it("updates a generated .gitignore so edit.json is committed", async () => {
    const root = await connected();
    await pretendOld(root, OLD);
    const refreshed = await refreshStateFiles({ root });
    expect(refreshed.ok && refreshed.data.updated).toEqual([".clipmunk/.gitignore"]);
    expect(await readFile(path.join(root, ".clipmunk/.gitignore"), "utf8")).toContain("!takes/*/edit.json");
    const again = await refreshStateFiles({ root });
    expect(again.ok && again.data.updated).toEqual([]);
  });

  it("leaves an edited .gitignore alone and says what to add", async () => {
    const root = await connected();
    await pretendOld(root, `${OLD}notes/\n`);
    const refreshed = await refreshStateFiles({ root });
    expect(refreshed.ok && refreshed.data.updated).toEqual([]);
    expect(refreshed.ok && refreshed.data.issues[0]!.message).toContain("takes/*/edit.json");
    expect(await readFile(path.join(root, ".clipmunk/.gitignore"), "utf8")).toBe(`${OLD}notes/\n`);
  });

  it("does nothing outside a connected project", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "clipmunk-state-"));
    roots.push(root);
    expect(await refreshStateFiles({ root })).toEqual({ ok: true, data: { updated: [], issues: [] } });
  });
});
