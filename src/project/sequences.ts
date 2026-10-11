import { rm } from "node:fs/promises";
import {
  fail,
  type Issue,
  ok,
  type Result,
  SEQUENCES_DIR,
  type Sequence,
  SequenceSchema,
  TAKES_DIR,
  zodIssues,
} from "../core";
import { type Context, discoverScenes } from "./operations";
import { exists, Fault, listFiles, readText, resolveInside, toIssues, writeText } from "./services";

/** Sequences on disk: src/flick/sequences/<id>.sequence.json. Every clip a sequence
 * names must exist, and that is checked here so the CLI, the daemon and export agree.
 */
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const fileOf = (id: string) => {
  if (!ID.test(id)) throw new Fault("invalid-sequence", `"${id}" is not a sequence id. Use a lowercase slug.`);
  return `${SEQUENCES_DIR}/${id}.sequence.json`;
};

async function missingClips(sequence: Sequence, context: Context): Promise<Issue[]> {
  const scenes = new Set((await discoverScenes(context)).scenes.map((scene) => scene.id));
  const issues: Issue[] = [];
  for (const [index, item] of sequence.items.entries()) {
    const found =
      item.clip.kind === "scene"
        ? scenes.has(item.clip.id)
        : await exists(context.root, `${TAKES_DIR}/${item.clip.id}/take.json`);
    if (!found)
      issues.push({
        code: "unknown-clip",
        path: `items.${index}.clip`,
        message: `There is no ${item.clip.kind} named "${item.clip.id}".`,
      });
  }
  return issues;
}

export async function readSequence(id: string, context: Context): Promise<Result<Sequence>> {
  try {
    const source = fileOf(id);
    const text = await readText(context.root, source);
    if (text === undefined)
      throw new Fault("unknown-sequence", `No sequence named "${id}". Run flick sequences to list them.`);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      throw new Fault("invalid-json", `${source} is not valid JSON: ${(error as Error).message}`, source);
    }
    const parsed = SequenceSchema.safeParse(json);
    if (!parsed.success)
      return fail(
        zodIssues(parsed.error, "invalid-sequence").map((issue) => ({ ...issue, path: `${source}: ${issue.path}` })),
      );
    if (parsed.data.id !== id)
      return fail([
        {
          code: "id-mismatch",
          path: source,
          message: `The sequence id "${parsed.data.id}" must equal its file name "${id}".`,
        },
      ]);
    const missing = await missingClips(parsed.data, context);
    return missing.length
      ? fail(missing.map((issue) => ({ ...issue, path: `${source}: ${issue.path}` })))
      : ok(parsed.data);
  } catch (error) {
    return fail(toIssues(error, "invalid-sequence"));
  }
}

export async function listSequences(context: Context): Promise<Result<{ sequences: Sequence[]; issues: Issue[] }>> {
  try {
    const sequences: Sequence[] = [];
    const issues: Issue[] = [];
    for (const name of await listFiles(context.root, SEQUENCES_DIR)) {
      const id = /^(.+)\.sequence\.json$/.exec(name)?.[1];
      if (!id) continue;
      const result = ID.test(id)
        ? await readSequence(id, context)
        : fail([
            {
              code: "invalid-sequence",
              path: `${SEQUENCES_DIR}/${name}`,
              message: "Name the file with a lowercase slug.",
            },
          ]);
      if (result.ok) sequences.push(result.data);
      else issues.push(...result.issues);
    }
    return ok({ sequences, issues });
  } catch (error) {
    return fail(toIssues(error, "sequences-failed"));
  }
}

export async function writeSequence(id: string, input: unknown, context: Context): Promise<Result<Sequence>> {
  try {
    const source = fileOf(id);
    const parsed = SequenceSchema.safeParse(input);
    if (!parsed.success) return fail(zodIssues(parsed.error, "invalid-sequence"));
    if (parsed.data.id !== id)
      return fail([{ code: "id-mismatch", message: `The sequence id "${parsed.data.id}" must equal "${id}".` }]);
    const missing = await missingClips(parsed.data, context);
    if (missing.length) return fail(missing);
    await writeText(context.root, source, `${JSON.stringify(parsed.data, null, 2)}\n`);
    return ok(parsed.data);
  } catch (error) {
    return fail(toIssues(error, "invalid-sequence"));
  }
}

export async function deleteSequence(id: string, context: Context): Promise<Result<{ id: string }>> {
  try {
    const source = fileOf(id);
    if (!(await exists(context.root, source))) throw new Fault("unknown-sequence", `No sequence named "${id}".`);
    await rm(await resolveInside(context.root, source));
    return ok({ id });
  } catch (error) {
    return fail(toIssues(error, "delete-failed"));
  }
}
