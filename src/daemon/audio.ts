import { rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  AUDIO_DIR,
  type AudioClip,
  fail,
  type Music,
  MusicSchema,
  ok,
  type Result,
  SCENES_DIR,
  SceneRecipeSchema,
  zodIssues,
} from "../core";
import { extractAudio } from "../export";
import { Fault, readText, resolveInside, toIssues, writeText } from "../project";

/** Narration recorded over a scene. The sound is stored as WAV in .flick/audio and the
 * scene's recipe points at it, so preview and export find it the same way.
 */
type Context = { root: string };
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const isNarration = (sceneId: string, file: string) => file.startsWith(`${sceneId}-narration-`);

async function recipeOf(sceneId: string, context: Context) {
  if (!ID.test(sceneId)) throw new Fault("unknown-scene", `"${sceneId}" is not a scene id.`);
  const source = `${SCENES_DIR}/${sceneId}.scene.json`;
  const text = await readText(context.root, source);
  if (text === undefined) throw new Fault("unknown-scene", `No scene named "${sceneId}".`);
  const json = JSON.parse(text) as Record<string, unknown>;
  const parsed = SceneRecipeSchema.safeParse(json);
  if (!parsed.success)
    throw new Fault("invalid-scene", `${source} has errors; fix them before recording narration.`, source);
  return { source, json, audio: parsed.data.audio ?? [] };
}
async function saveAudio(
  sceneId: string,
  context: Context,
  next: AudioClip[],
  recipe: Awaited<ReturnType<typeof recipeOf>>,
) {
  const { audio: _old, ...rest } = recipe.json;
  await writeText(
    context.root,
    recipe.source,
    `${JSON.stringify(next.length ? { ...rest, audio: next } : rest, null, 2)}\n`,
  );
  // Files of narration that the recipe no longer uses would only pile up.
  for (const clip of recipe.audio)
    if (isNarration(sceneId, clip.file) && !next.some((kept) => kept.file === clip.file))
      await rm(await resolveInside(context.root, `${AUDIO_DIR}/${clip.file}`), { force: true });
}

export async function storeNarration(
  sceneId: string,
  data: Buffer,
  offsetMs: number,
  context: Context,
  now = new Date(),
): Promise<Result<{ audio: AudioClip[] }>> {
  try {
    if (!data.length) throw new Fault("empty-recording", "No sound was received.");
    const recipe = await recipeOf(sceneId, context);
    const name = `${sceneId}-narration-${now.toISOString().replace(/\D/g, "").slice(0, 14)}`;
    const raw = `${AUDIO_DIR}/${name}.upload`;
    await writeText(context.root, raw, data);
    const directory = await resolveInside(context.root, AUDIO_DIR);
    try {
      await extractAudio(`${name}.upload`, `${name}.wav`, directory);
    } finally {
      await rm(path.join(directory, `${name}.upload`), { force: true });
    }
    // One narration per scene: a new recording replaces the previous one; other sounds stay.
    const next = [
      ...recipe.audio.filter((clip) => !isNarration(sceneId, clip.file)),
      { file: `${name}.wav`, offsetMs: Math.round(offsetMs), gain: 1 },
    ];
    await saveAudio(sceneId, context, next, recipe);
    return ok({ audio: next });
  } catch (error) {
    return fail(toIssues(error, "narration-failed"));
  }
}

export async function removeNarration(sceneId: string, context: Context): Promise<Result<{ audio: AudioClip[] }>> {
  try {
    const recipe = await recipeOf(sceneId, context);
    const next = recipe.audio.filter((clip) => !isNarration(sceneId, clip.file));
    await saveAudio(sceneId, context, next, recipe);
    return ok({ audio: next });
  } catch (error) {
    return fail(toIssues(error, "narration-failed"));
  }
}

/** Absolute path of a sound in .flick/audio. Only plain file names are accepted. */
export async function audioFile(name: string, context: Context): Promise<string> {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name) || name.includes(".."))
    throw new Fault("unknown-file", `"${name}" is not an audio file name.`);
  const absolute = await resolveInside(context.root, `${AUDIO_DIR}/${name}`);
  if (
    !(await stat(absolute).then(
      (info) => info.isFile(),
      () => false,
    ))
  )
    throw new Fault("unknown-file", `${AUDIO_DIR}/${name} does not exist.`);
  return absolute;
}

/** Set or clear a scene's generated music. Only the recipe's `music` field changes. */
export async function setSceneMusic(
  sceneId: string,
  input: unknown,
  context: Context,
): Promise<Result<{ music: Music | null }>> {
  try {
    const recipe = await recipeOf(sceneId, context);
    const { music: _old, ...rest } = recipe.json;
    if (input === null || input === undefined) {
      await writeText(context.root, recipe.source, `${JSON.stringify(rest, null, 2)}\n`);
      return ok({ music: null });
    }
    const parsed = MusicSchema.safeParse(input);
    if (!parsed.success) return fail(zodIssues(parsed.error, "invalid-music"));
    await writeText(context.root, recipe.source, `${JSON.stringify({ ...rest, music: parsed.data }, null, 2)}\n`);
    return ok({ music: parsed.data });
  } catch (error) {
    return fail(toIssues(error, "music-failed"));
  }
}
