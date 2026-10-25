/** JSON merge patches (RFC 7386), which is how an agent edits a take: an object with only the
 * parts to change, `null` to remove a key. One addition: an object that switches its `mode` (such
 * as `zoom: { mode: "off" }`) replaces the old object, whose other fields belonged to the old mode.
 * And a readable diff of what an edit changed.
 */
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function mergePatch(target: unknown, patch: unknown): unknown {
  if (!isObject(patch)) return patch;
  const switched = isObject(target) && "mode" in patch && "mode" in target && patch.mode !== target.mode;
  const result: Record<string, unknown> = isObject(target) && !switched ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else result[key] = mergePatch(result[key], value);
  }
  return result;
}

export type Change = { path: string; before?: unknown; after?: unknown };
/** Every leaf that differs between two JSON values, with its dotted path. Arrays compare whole. */
export function diffJson(before: unknown, after: unknown, path = ""): Change[] {
  if (isObject(before) && isObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    return keys.flatMap((key) => diffJson(before[key], after[key], path ? `${path}.${key}` : key));
  }
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  return [
    { path: path || "(root)", ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}) },
  ];
}

export const formatChanges = (changes: readonly Change[]) =>
  changes.length
    ? changes
        .map(
          (change) =>
            `${change.path}: ${JSON.stringify(change.before ?? null)} -> ${JSON.stringify(change.after ?? null)}`,
        )
        .join("\n")
    : "No change.";
export type { Json };
