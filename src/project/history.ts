import { fail, ok, type Result, type Take } from "../core";
import { readText, writeText } from "./services";
import { loadTake, saveTakeEdit } from "./takes";

/** Undo and redo for take edits. Each take keeps a list of its edits (with the title) in
 * `.clipmunk/history/<id>.json`, which git ignores, capped at the last 50. Undo and redo save an
 * earlier or later entry through the normal revision-checked save, so they are ordinary edits to
 * `edit.json` and a stale page is refused the same way.
 */
export const HISTORY_DIR = ".clipmunk/history";
const CAP = 50;
type Snapshot = { edit: unknown; title: string };
type History = { version: 1; entries: Snapshot[]; index: number };

const fileOf = (id: string) => `${HISTORY_DIR}/${id}.json`;
const same = (a: Snapshot, b: Snapshot) => JSON.stringify(a) === JSON.stringify(b);
const snapshot = (take: Take): Snapshot => ({ edit: take.edit, title: take.title });

async function read(root: string, id: string): Promise<History | undefined> {
  try {
    const history = JSON.parse((await readText(root, fileOf(id))) ?? "null") as History | null;
    return history?.version === 1 && Array.isArray(history.entries) ? history : undefined;
  } catch {
    return undefined;
  }
}
const write = (root: string, id: string, history: History) =>
  writeText(root, fileOf(id), `${JSON.stringify(history)}\n`);

/** Save an edit and remember it. Redo is lost once a new edit is made after an undo. */
export async function saveTakeEditWithHistory(
  root: string,
  id: string,
  input: { edit?: unknown; title?: unknown; revision?: unknown },
): Promise<Result<{ take: Take; revision: string }>> {
  const before = await loadTake(root, id);
  const saved = await saveTakeEdit(root, id, input);
  if (!saved.ok || !before.ok) return saved;
  const previous = snapshot(before.data.take),
    next = snapshot(saved.data.take);
  if (same(previous, next)) return saved;
  const history = (await read(root, id)) ?? { version: 1, entries: [], index: -1 };
  const entries = history.entries.slice(0, history.index + 1);
  // The edit file may have changed outside the Studio since the last entry; keep that state too.
  if (!entries.length || !same(entries.at(-1)!, previous)) entries.push(previous);
  entries.push(next);
  const kept = entries.slice(-CAP);
  await write(root, id, { version: 1, entries: kept, index: kept.length - 1 });
  return saved;
}

export type HistoryState = { canUndo: boolean; canRedo: boolean };
export async function historyState(root: string, id: string): Promise<HistoryState> {
  const history = await read(root, id);
  const current = await loadTake(root, id);
  if (!history || !current.ok) return { canUndo: false, canRedo: false };
  const atEntry = same(history.entries[history.index]!, snapshot(current.data.take));
  return {
    canUndo: atEntry ? history.index > 0 : history.entries.length > 0,
    canRedo: atEntry && history.index < history.entries.length - 1,
  };
}

/** Undo (-1) or redo (+1) one edit. `revision` is the one the caller holds. */
export async function stepTakeHistory(
  root: string,
  id: string,
  step: -1 | 1,
  revision: unknown,
): Promise<Result<{ take: Take; revision: string } & HistoryState>> {
  const history = await read(root, id);
  const current = await loadTake(root, id);
  if (!current.ok) return current;
  if (!history) return fail([{ code: "nothing-to-undo", message: "This take has no edits to undo or redo." }]);
  let { entries, index } = history;
  // Changed outside the Studio since: that state becomes the newest entry, and undo returns to the last known one.
  if (!same(entries[index]!, snapshot(current.data.take))) {
    entries = [...entries.slice(0, index + 1), snapshot(current.data.take)];
    index = entries.length - 1;
  }
  const target = index + step;
  if (target < 0 || target >= entries.length)
    return fail([
      {
        code: "nothing-to-undo",
        message: step < 0 ? "There is nothing earlier to undo." : "There is nothing to redo.",
      },
    ]);
  const entry = entries[target]!;
  const saved = await saveTakeEdit(root, id, { edit: entry.edit, title: entry.title, revision });
  if (!saved.ok) return saved;
  await write(root, id, { version: 1, entries, index: target });
  return ok({ ...saved.data, canUndo: target > 0, canRedo: target < entries.length - 1 });
}
