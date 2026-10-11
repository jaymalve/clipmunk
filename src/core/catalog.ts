import { type SceneRecipe, SceneRecipeSchema } from "./recipe";
import type { Issue } from "./result";

/** The scene catalog: every `<id>.scene.json` paired with its `<id>.tsx` or `<id>.jsx`.
 * The CLI (reading files) and the studio (reading bundler modules) both call this,
 * so they always agree on which scenes exist and why one is rejected.
 * Component source is never executed here; only paths are matched.
 */
export type CatalogScene = SceneRecipe & { source: string; binding: string };
export type SceneCatalog = { scenes: CatalogScene[]; selected?: CatalogScene; issues: Issue[] };
export type CatalogInput = {
  sources: readonly { path: string; document: unknown }[];
  bindings: readonly string[];
  sceneId?: string;
};

const SOURCE = /(?:^|\/)([^/]+)\.scene\.json$/;
const BINDING = /(?:^|\/)([^/]+)\.(?:tsx|jsx)$/;

export function loadSceneCatalog(input: CatalogInput): SceneCatalog {
  const issues: Issue[] = [];
  const bindings = new Map<string, string[]>();
  for (const path of input.bindings) {
    const name = BINDING.exec(path)?.[1];
    if (name) bindings.set(name, [...(bindings.get(name) ?? []), path]);
  }
  const scenes: CatalogScene[] = [];
  const seen = new Set<string>();
  for (const source of [...input.sources].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    const name = SOURCE.exec(source.path)?.[1];
    if (!name) continue;
    const parsed = SceneRecipeSchema.safeParse(source.document);
    if (!parsed.success) {
      for (const issue of parsed.error.issues)
        issues.push({
          code: "invalid-scene",
          path: `${source.path}: ${issue.path.join(".") || "(root)"}`,
          message: issue.message,
        });
      continue;
    }
    if (parsed.data.id !== name) {
      issues.push({
        code: "id-mismatch",
        path: source.path,
        message: `The recipe id "${parsed.data.id}" must equal its file name "${name}".`,
      });
      continue;
    }
    if (seen.has(name)) {
      issues.push({
        code: "duplicate-scene",
        path: source.path,
        message: `Scene "${name}" is defined more than once.`,
      });
      continue;
    }
    const matches = bindings.get(name) ?? [];
    if (matches.length !== 1) {
      issues.push(
        matches.length
          ? {
              code: "ambiguous-binding",
              path: source.path,
              message: `Scene "${name}" has both a .tsx and a .jsx component. Keep one.`,
            }
          : {
              code: "missing-binding",
              path: source.path,
              message: `Scene "${name}" needs a component next to it: ${name}.tsx or ${name}.jsx with a default export.`,
            },
      );
      continue;
    }
    seen.add(name);
    scenes.push({ ...parsed.data, source: source.path, binding: matches[0]! });
  }
  const selected = input.sceneId === undefined ? undefined : scenes.find((scene) => scene.id === input.sceneId);
  if (input.sceneId !== undefined && !selected)
    issues.push({
      code: "unknown-scene",
      path: input.sceneId,
      message: `No valid scene named "${input.sceneId}". Run flick scenes to list them.`,
    });
  return { scenes, selected, issues };
}
