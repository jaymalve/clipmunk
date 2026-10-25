import path from "node:path";
import {
  AUDIO_DIR,
  type ExportSequenceResult,
  ExportSequenceSchema,
  fail,
  type Issue,
  ok,
  planSequence,
  type RenderedSounds,
  type Result,
  type Sequence,
  zodIssues,
} from "../core";
import { discoverScenes, exists, Fault, readSequence, resolveInside, toIssues } from "../project";
import { joinClips, type PlacedAudio } from "./ffmpeg";
import { writeMusic, writeSounds } from "./music";
import { type ExportContext, exportScene, sceneSounds } from "./operations";
import {
  CANCELLED,
  type Cancellation,
  cancellation,
  claimOutput,
  noteExport,
  publish,
  removeDirectory,
  workDirectory,
} from "./output";
import { exportTake } from "./take";

/** Export a sequence: render each clip at the sequence's size and frame rate with the
 * ordinary scene and take exporters, then join the results with cuts or cross-fades.
 */
type RenderedClip = { file: string; durationMs: number; hasAudio: boolean };
const keyOf = (clip: { kind: string; id: string }) => `${clip.kind}:${clip.id}`;

/** Render every distinct clip once into `directory` (project-relative), reporting overall progress. */
async function renderClips(
  sequence: Sequence,
  url: string,
  directory: string,
  context: ExportContext,
  cancel: Cancellation,
): Promise<Result<Map<string, RenderedClip>>> {
  const rendered = new Map<string, RenderedClip>();
  const unique = [...new Map(sequence.items.map((item) => [keyOf(item.clip), item.clip])).values()];
  for (const [index, clip] of unique.entries()) {
    cancel.check();
    const file = `${directory}/clip-${index}.mp4`;
    // With music over the whole sequence, a clip's own music would play on top of it.
    const shared = {
      url,
      output: file,
      fps: sequence.fps,
      width: sequence.width,
      height: sequence.height,
      music: !sequence.music,
    };
    const onProgress = (done: number, total: number) =>
      context.onProgress?.(Math.round(((index + done / total) / unique.length) * 1000), 1000);
    const result =
      clip.kind === "scene"
        ? // A scene's sound effects are laid over the whole sequence instead, so they never lower its music.
          await exportScene({ ...shared, sceneId: clip.id, sounds: false }, { ...context, onProgress, manifest: false })
        : await exportTake({ ...shared, takeId: clip.id }, { ...context, onProgress, manifest: false });
    if (!result.ok)
      return fail(
        result.issues.map((issue: Issue) => ({ ...issue, message: `${clip.kind} "${clip.id}": ${issue.message}` })),
      );
    rendered.set(keyOf(clip), {
      file: await resolveInside(context.root, file),
      durationMs: result.data.durationMs,
      hasAudio: result.data.audio,
    });
  }
  return ok(rendered);
}

/** Every scene's sound effects, each placed where its clip starts, on one track as long as
 * the sequence. Returns nothing when no scene has any.
 */
async function sequenceSounds(
  sequence: Sequence,
  plan: { startsMs: number[]; totalMs: number },
  clips: RenderedClip[],
  context: ExportContext,
): Promise<RenderedSounds | undefined> {
  const { scenes } = await discoverScenes(context);
  const byId = new Map(scenes.map((scene) => [scene.id, scene]));
  let mixed: RenderedSounds | undefined;
  sequence.items.forEach((item, index) => {
    const scene = item.clip.kind === "scene" ? byId.get(item.clip.id) : undefined;
    if (!scene?.sounds?.length) return;
    const own = sceneSounds(scene, clips[index]!.durationMs);
    const total = Math.round((plan.totalMs / 1000) * own.sampleRate);
    mixed ??= { sampleRate: own.sampleRate, left: new Float32Array(total), right: new Float32Array(total) };
    const offset = Math.round((plan.startsMs[index]! / 1000) * own.sampleRate);
    for (let i = 0; i < own.left.length && offset + i < total; i++) {
      mixed.left[offset + i]! += own.left[i]!;
      mixed.right[offset + i]! += own.right[i]!;
    }
  });
  return mixed;
}

/** Sound files laid over the whole sequence. Unlike a scene, a missing one is an error: it was asked for by name. */
async function overlayTracks(root: string, sequence: Sequence): Promise<PlacedAudio[]> {
  const tracks: PlacedAudio[] = [];
  for (const track of sequence.audio ?? []) {
    const file = `${AUDIO_DIR}/${track.file}`;
    if (!(await exists(root, file)))
      throw new Fault("missing-audio", `${file} does not exist. Add the file or remove it from the sequence.`);
    tracks.push({ ...track, file: await resolveInside(root, file) });
  }
  return tracks;
}

export async function exportSequence(input: unknown, context: ExportContext): Promise<Result<ExportSequenceResult>> {
  const parsed = ExportSequenceSchema.safeParse(input);
  if (!parsed.success) return fail(zodIssues(parsed.error, "invalid-export"));
  const request = parsed.data;
  const started = Date.now();
  const { root } = context;
  const cancel = cancellation(context.signal);
  let directory: string | undefined;
  try {
    const loaded = await readSequence(request.sequenceId, context);
    if (!loaded.ok) return loaded;
    const sequence = loaded.data;
    const claim = await claimOutput(root, request.output, sequence.id);
    directory = await workDirectory(claim);
    // The clip exporters take project-relative outputs; the work directory sits beside the final file.
    const relative = `${path.posix.dirname(claim.output)}/${path.basename(directory)}`;

    const rendered = await renderClips(sequence, request.url, relative, context, cancel);
    if (!rendered.ok) return rendered;
    const clips = sequence.items.map((item) => rendered.data.get(keyOf(item.clip))!);
    const plan = planSequence(
      sequence.items,
      clips.map((clip) => clip.durationMs),
    );
    const overlay = await overlayTracks(root, sequence);
    // The music marks each join between clips, at the middle of its fade.
    const joins = plan.startsMs.slice(1).map((start, index) => start + plan.fadesMs[index + 1]! / 2);
    const music =
      sequence.music &&
      (await writeMusic(directory, sequence.music, {
        key: `sequence:${sequence.id}`,
        durationMs: plan.totalMs,
        momentsMs: joins,
        accentLevel: 1,
      }));
    const sounds = await sequenceSounds(sequence, plan, clips, context);
    const effects = sounds && (await writeSounds(directory, sounds));

    const joined = path.join(directory, "sequence.mp4");
    const { audio } = await joinClips({
      clips,
      fadesMs: plan.fadesMs,
      fps: sequence.fps,
      width: sequence.width,
      height: sequence.height,
      overlay,
      music,
      effects,
      totalMs: plan.totalMs,
      output: joined,
      cwd: root,
    });
    cancel.check();
    await publish(joined, claim);
    await noteExport(context, { kind: "sequence", id: request.sequenceId }, [claim.output]);
    return ok({
      output: claim.output,
      fps: sequence.fps,
      durationMs: Math.round(plan.totalMs),
      width: sequence.width,
      height: sequence.height,
      items: sequence.items.length,
      audio,
      elapsedMs: Date.now() - started,
    });
  } catch (error) {
    return fail(cancel.cancelled() ? [CANCELLED] : toIssues(error, "export-failed"));
  } finally {
    cancel.release();
    await removeDirectory(directory);
  }
}
