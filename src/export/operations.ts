import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AUDIO_DIR,
  type CatalogScene,
  type ExportSceneResult,
  ExportSceneSchema,
  fail,
  frameUrl,
  MAX_EXPORT_DURATION_MS,
  ok,
  type RenderedSounds,
  type Result,
  renderSounds,
  SceneRecipeSchema,
  SNAPSHOT_WIDTH,
  type SnapshotSceneResult,
  SnapshotSceneSchema,
  sceneMoments,
  seedFor,
  VARIANT_PARAM,
  zodIssues,
} from "../core";
import { type Context, exists, Fault, readText, resolveInside, resolveStudio, toIssues, writeText } from "../project";
import { launchBrowser, openClip } from "./browser";
import { addAudio, concatSegments, type Encoder, type PlacedAudio, startEncoder } from "./ffmpeg";
import { writeMusic, writeSounds } from "./music";
import {
  CANCELLED,
  type Cancellation,
  cancellation,
  claimOutput,
  even,
  publish,
  removeDirectory,
  workDirectory,
} from "./output";

/** Rendering operations. A scene is sampled at exact frame times through the same
 * bridge the studio uses, so the file matches the preview frame for frame.
 */
export type ExportContext = Context & { signal?: AbortSignal; onProgress?: (done: number, total: number) => void };
type SceneRequest = ReturnType<typeof ExportSceneSchema.parse>;
type Browser = Awaited<ReturnType<typeof launchBrowser>>;
type RenderPlan = { durationMs: number; width: number; height: number; frames: number; workers: number };

/** Open the scene once at a neutral size to learn its authored frame, and decide the output from it. */
async function planRender(browser: Browser, url: string, request: SceneRequest): Promise<RenderPlan> {
  const probe = await openClip(browser, url, { width: 1280, height: 720 });
  const info = probe.info;
  await probe.close();
  if (info.durationMs <= 0)
    throw new Fault(
      "still-scene",
      "This scene has no motion, so there is no video to export. Use clipmunk snapshot for a still.",
    );
  if (info.durationMs > MAX_EXPORT_DURATION_MS)
    throw new Fault("too-long", `Scenes longer than ${MAX_EXPORT_DURATION_MS / 60000} minutes are not supported.`);
  const width = request.width ?? even(request.height ? (request.height * info.width) / info.height : info.width);
  const height = request.height ?? even(request.width ? (request.width * info.height) / info.width : info.height);
  const frames = Math.ceil((info.durationMs * request.fps) / 1000);
  const workers = Math.min(request.workers ?? Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2))), frames);
  return { durationMs: info.durationMs, width, height, frames, workers };
}

/** Split the frames across pages, encode one segment per page, and join the segments.
 * Every frame is a pure function of time, so the pages can work independently.
 */
async function renderFrames(options: {
  browser: Browser;
  url: string;
  plan: RenderPlan;
  request: SceneRequest;
  root: string;
  directory: string;
  cancel: Cancellation;
  onProgress?: (done: number, total: number) => void;
}): Promise<string> {
  const { browser, plan, request, directory, cancel } = options;
  const format = request.draft ? "jpeg" : "png";
  const segments = Array.from({ length: plan.workers }, (_, index) => ({
    file: path.join(directory, `segment-${index}.mp4`),
    from: Math.floor((plan.frames * index) / plan.workers),
    to: Math.floor((plan.frames * (index + 1)) / plan.workers),
  }));
  const encoders: Encoder[] = [];
  cancel.onCancel(() => {
    for (const encoder of encoders) encoder.kill();
  });
  let done = 0;
  try {
    await Promise.all(
      segments.map(async (segment) => {
        const clip = await openClip(browser, options.url, { width: plan.width, height: plan.height });
        const encoder = startEncoder({
          output: segment.file,
          fps: request.fps,
          width: plan.width,
          height: plan.height,
          frames: segment.to - segment.from,
          input: request.draft ? "mjpeg" : "png",
          cwd: options.root,
        });
        encoders.push(encoder);
        try {
          for (let frame = segment.from; frame < segment.to; frame++) {
            cancel.check();
            await encoder.write(await clip.frame(Math.min(plan.durationMs, (frame * 1000) / request.fps), format));
            options.onProgress?.(++done, plan.frames);
          }
          await encoder.finish();
        } finally {
          await clip.close().catch(() => {});
        }
      }),
    );
  } finally {
    for (const encoder of encoders) encoder.kill();
  }
  cancel.check();
  const joined = path.join(directory, "joined.mp4");
  const list = path.join(directory, "segments.txt");
  await writeFile(list, segments.map((segment) => `file '${segment.file.replace(/'/g, "'\\''")}'`).join("\n"));
  await concatSegments(
    segments.map((segment) => segment.file),
    list,
    joined,
    options.root,
  );
  return joined;
}

/** A scene's sound effects over `durationMs` of its clip. A sequence calls this too, so a
 * scene sounds the same on its own and inside one.
 */
export function sceneSounds(scene: CatalogScene, durationMs: number): RenderedSounds {
  return renderSounds({
    sounds: scene.sounds ?? [],
    durationMs,
    speed: scene.definition.motion?.speed,
    seed: seedFor(`scene:${scene.id}`),
  });
}

/** The scene's sound: its audio clips that exist on disk, and its generated music.
 * A missing file is reported as a warning, not a failure.
 */
async function sceneSound(
  root: string,
  scene: CatalogScene,
  request: SceneRequest,
  directory: string,
  durationMs: number,
) {
  const warnings: string[] = [];
  const tracks: PlacedAudio[] = [];
  for (const clip of scene.audio ?? []) {
    const file = `${AUDIO_DIR}/${clip.file}`;
    if (await exists(root, file)) tracks.push({ ...clip, file: await resolveInside(root, file) });
    else warnings.push(`${file} is missing, so this scene was exported without it.`);
  }
  const wanted = request.music ? scene.music : undefined;
  const music =
    wanted &&
    (await writeMusic(directory, wanted, {
      key: `scene:${scene.id}`,
      durationMs,
      momentsMs: sceneMoments(scene.definition),
    }));
  const effects =
    request.sounds && scene.sounds?.length ? await writeSounds(directory, sceneSounds(scene, durationMs)) : undefined;
  return { tracks, music, effects, warnings };
}

export async function exportScene(input: unknown, context: ExportContext): Promise<Result<ExportSceneResult>> {
  const parsed = ExportSceneSchema.safeParse(input);
  if (!parsed.success) return fail(zodIssues(parsed.error, "invalid-export"));
  const request = parsed.data;
  const started = Date.now();
  const { root } = context;
  const cancel = cancellation(context.signal);
  let browser: Browser | undefined;
  let directory: string | undefined;
  try {
    cancel.check();
    const claim = await claimOutput(root, request.output, request.sceneId);
    const studio = await resolveStudio({ url: request.url, sceneId: request.sceneId }, context);
    if (!studio.ok) return studio;
    const scene = studio.data.scene!;

    browser = await launchBrowser();
    cancel.onCancel(() => void browser?.close());
    // The frame page: the scene alone, exactly as the Studio's preview shows it.
    const url = new URL(frameUrl(new URL(studio.data.url).origin, studio.data.project.studioPath, request.sceneId));
    if (request.variant) url.searchParams.set(VARIANT_PARAM, request.variant);
    const plan = await planRender(browser, url.toString(), request);
    directory = await workDirectory(claim);
    const picture = await renderFrames({
      browser,
      url: url.toString(),
      plan,
      request,
      root,
      directory,
      cancel,
      onProgress: context.onProgress,
    });
    cancel.check();

    const durationMs = (plan.frames * 1000) / request.fps;
    const sound = await sceneSound(root, scene, request, directory, durationMs);
    let finished = picture;
    if (sound.tracks.length || sound.music || sound.effects) {
      finished = path.join(directory, "with-audio.mp4");
      await addAudio({
        video: picture,
        output: finished,
        cwd: root,
        durationMs,
        tracks: sound.tracks,
        music: sound.music,
        effects: sound.effects,
      });
    }
    await publish(finished, claim);
    return ok({
      output: claim.output,
      fps: request.fps,
      frames: plan.frames,
      durationMs,
      width: plan.width,
      height: plan.height,
      workers: plan.workers,
      audio: sound.tracks.length > 0 || !!sound.music || !!sound.effects,
      elapsedMs: Date.now() - started,
      ...(sound.warnings.length ? { warnings: sound.warnings } : {}),
    });
  } catch (error) {
    return fail(cancel.cancelled() ? [CANCELLED] : toIssues(error, "export-failed"));
  } finally {
    cancel.release();
    await browser?.close().catch(() => {});
    await removeDirectory(directory);
  }
}

/** Capture one frame as a small PNG and store it in the recipe for the library. */
export async function snapshotScene(input: unknown, context: ExportContext): Promise<Result<SnapshotSceneResult>> {
  const parsed = SnapshotSceneSchema.safeParse(input);
  if (!parsed.success) return fail(zodIssues(parsed.error, "invalid-snapshot"));
  let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
  try {
    const studio = await resolveStudio({ url: parsed.data.url, sceneId: parsed.data.sceneId }, context);
    if (!studio.ok) return studio;
    const source = `src/clipmunk/scenes/${parsed.data.sceneId}.scene.json`;
    const original = await readText(context.root, source);
    if (original === undefined) throw new Fault("unknown-scene", `${source} was not found.`, source);
    const recipe = SceneRecipeSchema.parse(JSON.parse(original));
    const height = Math.max(64, Math.round((SNAPSHOT_WIDTH * recipe.definition.height) / recipe.definition.width));
    browser = await launchBrowser();
    const page = frameUrl(new URL(studio.data.url).origin, studio.data.project.studioPath, parsed.data.sceneId);
    const clip = await openClip(browser, page, { width: SNAPSHOT_WIDTH, height });
    const timeMs = parsed.data.timeMs ?? clip.info.durationMs / 2;
    if (timeMs > clip.info.durationMs)
      throw new Fault("invalid-snapshot", `--time must be within the scene (0 to ${clip.info.durationMs} ms).`);
    const png = await clip.frame(timeMs, "png");
    const image = `data:image/png;base64,${png.toString("base64")}`;
    const next = SceneRecipeSchema.safeParse({ ...JSON.parse(original), snapshot: { image, timeMs } });
    if (!next.success)
      throw new Fault(
        "snapshot-too-large",
        "The snapshot is too large to store in the recipe. Simplify the frame or pick another --time.",
      );
    // The scene may have been edited while the browser was open; never clobber that edit.
    if ((await readText(context.root, source)) !== original)
      throw new Fault("source-changed", `${source} changed during the snapshot. Run it again.`, source);
    await writeText(
      context.root,
      source,
      `${JSON.stringify({ ...JSON.parse(original), snapshot: { image, timeMs } }, null, 2)}\n`,
    );
    return ok({ sceneId: recipe.id, source, timeMs, bytes: png.length });
  } catch (error) {
    return fail(toIssues(error, "snapshot-failed"));
  } finally {
    await browser?.close().catch(() => {});
  }
}
