import {
  applyPreset,
  CONFIG_FILE,
  describePreset,
  fail,
  ok,
  type Preset,
  type PresetField,
  PresetSchema,
  presetFromEdit,
  type Result,
  type Take,
  validateConfig,
  zodIssues,
} from "../core";
import { readConfig } from "./config";
import { readText, toIssues, writeText } from "./services";
import { loadTake, saveTakeEdit } from "./takes";

/** Presets live in clipmunk.config.json. These operations are shared by the CLI and the daemon. */
export type PresetSummary = { name: string; summary: string; preset: Preset };

export async function listPresets(root: string): Promise<Result<{ presets: PresetSummary[] }>> {
  const config = await readConfig(root);
  if (!config.ok) return config;
  const entries = Object.entries(config.data.config.presets ?? {});
  return ok({ presets: entries.map(([name, preset]) => ({ name, summary: describePreset(preset), preset })) });
}

async function findPreset(root: string, name: string): Promise<Result<Preset>> {
  const config = await readConfig(root);
  if (!config.ok) return config;
  const preset = config.data.config.presets?.[name];
  if (!preset) {
    const known = Object.keys(config.data.config.presets ?? {});
    return fail([
      {
        code: "unknown-preset",
        message: `No preset named "${name}" in ${CONFIG_FILE}.${known.length ? ` Presets: ${known.join(", ")}.` : ""}`,
      },
    ]);
  }
  return ok(preset);
}

/** Apply a preset to a take's edit and save it. The preset is read from the config each time. */
export async function applyPresetToTake(
  root: string,
  takeId: string,
  name: string,
): Promise<Result<{ take: Take; revision: string }>> {
  const preset = await findPreset(root, name);
  if (!preset.ok) return preset;
  const loaded = await loadTake(root, takeId);
  if (!loaded.ok) return loaded;
  const edit = applyPreset(loaded.data.take.edit, preset.data);
  if (!edit.ok) return edit;
  return saveTakeEdit(root, takeId, { edit: edit.data, revision: loaded.data.revision });
}

/** The music a preset gives a scene: `undefined` when it says nothing about music. */
export async function presetMusicFor(root: string, name: string): Promise<Result<Preset["music"]>> {
  const preset = await findPreset(root, name);
  return preset.ok ? ok(preset.data.music) : preset;
}

export type SavePresetInput =
  | { name: string; preset: unknown; replace?: boolean }
  | { name: string; fromTake: string; fields: PresetField[]; title?: string; replace?: boolean };

/** Write a preset into clipmunk.config.json. Everything else in the file keeps its content and
 * order, and the file keeps its indentation, so the diff shows only the preset. An existing
 * preset of that name is replaced only when asked.
 */
export async function savePreset(root: string, input: SavePresetInput): Promise<Result<PresetSummary>> {
  try {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.name))
      return fail([
        { code: "invalid-preset", path: "name", message: "A preset name is a lowercase slug, such as pr-walkthrough." },
      ]);
    let preset: Preset;
    if ("fromTake" in input) {
      const loaded = await loadTake(root, input.fromTake);
      if (!loaded.ok) return loaded;
      const made = presetFromEdit(loaded.data.take.edit, input.fields, input.title ? { title: input.title } : {});
      if (!made.ok) return made;
      preset = made.data;
    } else {
      const parsed = PresetSchema.safeParse(input.preset);
      if (!parsed.success) return fail(zodIssues(parsed.error, "invalid-preset"));
      preset = parsed.data;
    }

    const text = await readText(root, CONFIG_FILE);
    let json: Record<string, unknown>;
    try {
      json = text === undefined ? { version: 1 } : (JSON.parse(text) as Record<string, unknown>);
    } catch {
      return fail([{ code: "invalid-config", path: CONFIG_FILE, message: `${CONFIG_FILE} is not valid JSON.` }]);
    }
    const current = validateConfig(json);
    if (!current.ok) return current;
    const presets = (json.presets ?? {}) as Record<string, unknown>;
    if (Object.hasOwn(presets, input.name) && !input.replace)
      return fail([
        {
          code: "preset-exists",
          path: "name",
          message: `A preset named "${input.name}" already exists. Choose another name, or replace it.`,
        },
      ]);
    // Assigning keeps a replaced preset in its place and adds a new one at the end.
    const next = { ...json, presets: { ...presets, [input.name]: preset } };
    const checked = validateConfig(next);
    if (!checked.ok) return checked;
    await writeText(root, CONFIG_FILE, `${JSON.stringify(next, null, indentOf(text))}\n`);
    return ok({ name: input.name, summary: describePreset(preset), preset });
  } catch (error) {
    return fail(toIssues(error, "preset-failed"));
  }
}

/** The indentation a JSON file already uses: a tab, or a number of spaces (2 by default). */
export function indentOf(text: string | undefined): string | number {
  const first = text && /\n([ \t]+)\S/.exec(text)?.[1];
  if (!first) return 2;
  return first.startsWith("\t") ? "\t" : first.length;
}
