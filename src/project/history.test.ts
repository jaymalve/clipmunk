import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultEdit } from "../core";
import { historyState, loadTake, saveTakeEditWithHistory, stepTakeHistory } from "./index";

async function takeRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "clipmunk-history-"));
  const dir = path.join(root, ".clipmunk/takes/take-a");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "take.json"),
    JSON.stringify({
      version: 1,
      id: "take-a",
      title: "A",
      createdAt: "2026-10-25T00:00:00.000Z",
      source: {
        width: 640,
        height: 360,
        dpr: 1,
        durationMs: 4000,
        background: "#fff",
        screen: { file: "screen.webm", offsetMs: 0, latencyMs: 0, width: 640, height: 360 },
        events: { file: "events.jsonl", count: 0 },
      },
    }),
  );
  await writeFile(path.join(dir, "edit.json"), JSON.stringify({ version: 1, edit: defaultEdit(4000) }));
  return root;
}
const cursorOf = async (root: string) => {
  const loaded = await loadTake(root, "take-a");
  if (!loaded.ok) throw new Error("not loaded");
  return {
    visible: loaded.data.take.edit.cursor.visible,
    size: loaded.data.take.edit.cursor.size,
    revision: loaded.data.revision,
    edit: loaded.data.take.edit,
  };
};

describe("take history", () => {
  it("undoes and redoes edits through the normal save, and forgets redo after a new edit", async () => {
    const root = await takeRoot();
    expect(await historyState(root, "take-a")).toEqual({ canUndo: false, canRedo: false });
    let current = await cursorOf(root);
    const save = async (cursor: Partial<typeof current.edit.cursor>) => {
      const saved = await saveTakeEditWithHistory(root, "take-a", {
        edit: { ...current.edit, cursor: { ...current.edit.cursor, ...cursor } },
        revision: current.revision,
      });
      if (!saved.ok) throw new Error(JSON.stringify(saved.issues));
      current = await cursorOf(root);
    };
    await save({ visible: false });
    await save({ size: 2 });
    expect(await historyState(root, "take-a")).toEqual({ canUndo: true, canRedo: false });

    const undone = await stepTakeHistory(root, "take-a", -1, current.revision);
    expect(undone.ok && undone.data).toMatchObject({ canUndo: true, canRedo: true });
    current = await cursorOf(root);
    expect([current.visible, current.size]).toEqual([false, 1.4]);
    await stepTakeHistory(root, "take-a", -1, current.revision);
    current = await cursorOf(root);
    expect([current.visible, current.size]).toEqual([true, 1.4]);
    expect(await stepTakeHistory(root, "take-a", -1, current.revision)).toMatchObject({
      ok: false,
      issues: [{ code: "nothing-to-undo" }],
    });
    const redone = await stepTakeHistory(root, "take-a", 1, current.revision);
    expect(redone.ok).toBe(true);
    current = await cursorOf(root);
    expect(current.visible).toBe(false);

    // A stale page is refused, as with any save.
    expect(await stepTakeHistory(root, "take-a", 1, "old")).toMatchObject({
      ok: false,
      issues: [{ code: "stale-revision" }],
    });
    // A new edit after an undo drops what could have been redone.
    await save({ size: 3 });
    expect(await historyState(root, "take-a")).toEqual({ canUndo: true, canRedo: false });
  });
});
