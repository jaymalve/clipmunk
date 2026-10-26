import {
  composeTake,
  EDIT_FILE,
  editFileFor,
  fail,
  ok,
  type Result,
  TAKE_FILE,
  TAKES_DIR,
  type Take,
  TakeEditSchema,
  TakeSchema,
  zodIssues,
} from "../core";
import { Fault, readText, sha256, toIssues, writeText } from "./services";

/** Reading and saving a take's two files. `take.json` is the recording and is never written
 * here; every change goes to `edit.json`. The daemon, the CLI and the exporter all use these.
 */
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const takeDir = (id: string) => {
  if (!ID.test(id)) throw new Fault("invalid-take", `"${id}" is not a take id.`);
  return `${TAKES_DIR}/${id}`;
};

/** The revision covers both files, so a save is refused if either changed since it was read. */
const revisionOf = (takeText: string, editText: string | undefined) => sha256(`${takeText}\u0000${editText ?? ""}`);

type Loaded = { take: Take; revision: string; recordedTitle: string };
async function load(root: string, id: string): Promise<Result<Loaded>> {
  const dir = takeDir(id);
  const takeText = await readText(root, `${dir}/${TAKE_FILE}`);
  if (takeText === undefined)
    throw new Fault("unknown-take", `No take named "${id}". Run clipmunk takes to list them.`);
  const editText = await readText(root, `${dir}/${EDIT_FILE}`);
  const take = composeTake(
    parse(takeText, `${dir}/${TAKE_FILE}`),
    editText === undefined ? undefined : parse(editText, `${dir}/${EDIT_FILE}`),
  );
  if (!take.ok) return fail(take.issues.map((issue) => ({ ...issue, path: `${dir}/${issue.path}` })));
  const recordedTitle = (JSON.parse(takeText) as { title: string }).title;
  return ok({ take: take.data, revision: revisionOf(takeText, editText), recordedTitle });
}
function parse(text: string, file: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Fault("invalid-take", `${file} is not valid JSON.`, file);
  }
}

export async function loadTake(root: string, id: string): Promise<Result<{ take: Take; revision: string }>> {
  try {
    const loaded = await load(root, id);
    return loaded.ok ? ok({ take: loaded.data.take, revision: loaded.data.revision }) : loaded;
  } catch (error) {
    return fail(toIssues(error, "invalid-take"));
  }
}

/** Save an edit and, optionally, a new title. `revision` is the one the caller read; a
 * mismatch means someone else changed the take since, and nothing is written.
 */
export async function saveTakeEdit(
  root: string,
  id: string,
  input: { edit?: unknown; title?: unknown; revision?: unknown },
): Promise<Result<{ take: Take; revision: string }>> {
  try {
    const current = await load(root, id);
    if (!current.ok) return current;
    if (input.revision !== current.data.revision)
      return fail([
        {
          code: "stale-revision",
          message: "The take was changed since it was loaded. Reload it and apply the edit again.",
        },
      ]);
    const edit =
      input.edit === undefined
        ? { success: true as const, data: current.data.take.edit }
        : TakeEditSchema.safeParse(input.edit);
    if (!edit.success) return fail(zodIssues(edit.error, "invalid-take"));
    const next = TakeSchema.safeParse({
      ...current.data.take,
      edit: edit.data,
      ...(typeof input.title === "string" ? { title: input.title } : {}),
    });
    if (!next.success) return fail(zodIssues(next.error, "invalid-take"));
    const dir = takeDir(id);
    const editText = `${JSON.stringify(editFileFor(next.data, current.data.recordedTitle), null, 2)}\n`;
    await writeText(root, `${dir}/${EDIT_FILE}`, editText);
    const takeText = (await readText(root, `${dir}/${TAKE_FILE}`)) ?? "";
    return ok({ take: next.data, revision: revisionOf(takeText, editText) });
  } catch (error) {
    return fail(toIssues(error, "invalid-take"));
  }
}
