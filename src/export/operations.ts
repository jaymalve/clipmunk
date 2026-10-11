import { link, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AUDIO_DIR,
  sceneMoments,
  EXPORTS_DIR,
  ExportSceneSchema,
  MAX_EXPORT_DURATION_MS,
  SNAPSHOT_WIDTH,
  SceneRecipeSchema,
  SnapshotSceneSchema,
  fail,
  ok,
  zodIssues,
  type ExportSceneResult,
  type Result,
  type SnapshotSceneResult,
} from "../core";
import { Fault, exists, readText, resolveInside, resolveStudio, toIssues, writeText, type Context } from "../project";
import { launchBrowser, openClip } from "./browser";
import { addAudio, concatSegments, startEncoder, type Encoder } from "./ffmpeg";
import { writeMusic } from "./music";

/** Rendering operations. A scene is sampled at exact frame times through the same
 * bridge the studio uses, so the file matches the preview frame for frame.
 */
export type ExportContext = Context & { signal?: AbortSignal; onProgress?: (done: number, total: number) => void };
const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);

async function freeOutput(root: string, sceneId: string): Promise<string> {
  for (let n = 1; ; n++) {
    const candidate = `${EXPORTS_DIR}/${sceneId}${n === 1 ? "" : `-${n}`}.mp4`;
    if (!(await exists(root, candidate))) return candidate;
  }
}

export async function exportScene(input: unknown, context: ExportContext): Promise<Result<ExportSceneResult>> {
  const parsed = ExportSceneSchema.safeParse(input);
  if (!parsed.success) return fail(zodIssues(parsed.error, "invalid-export"));
  const request = parsed.data;
  const started = Date.now();
  const { root, signal } = context;
  const encoders: Encoder[] = [];
  let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
  let temporary: string | undefined;
  const abort = () => {
    for (const encoder of encoders) encoder.kill();
    void browser?.close();
  };
  const check = () => {
    if (signal?.aborted) throw new Fault("export-cancelled", "Export cancelled. No file was written.");
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    check();
    if (request.output && (await exists(root, request.output)))
      throw new Fault("output-exists", `${request.output} already exists. Choose another --output; Flick never overwrites a file.`, request.output);
    const studio = await resolveStudio({ url: request.url, sceneId: request.sceneId }, context);
    if (!studio.ok) return studio;
    const output = request.output ?? (await freeOutput(root, request.sceneId));
    const target = await resolveInside(root, output);

    browser = await launchBrowser();
    // Open once at a neutral size to learn the authored frame, then render at the output size.
    const probe = await openClip(browser, studio.data.url, { width: 1280, height: 720 });
    const info = probe.info;
    await probe.close();
    if (info.durationMs <= 0) throw new Fault("still-scene", "This scene has no motion, so there is no video to export. Use flick snapshot for a still.");
    if (info.durationMs > MAX_EXPORT_DURATION_MS) throw new Fault("too-long", `Scenes longer than ${MAX_EXPORT_DURATION_MS / 60000} minutes are not supported.`);
    const width = request.width ?? even(request.height ? (request.height * info.width) / info.height : info.width);
    const height = request.height ?? even(request.width ? (request.width * info.height) / info.width : info.height);
    const frames = Math.ceil((info.durationMs * request.fps) / 1000);
    const workers = Math.min(request.workers ?? Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2))), frames);

    await mkdir(path.dirname(target), { recursive: true });
    temporary = await mkdtemp(path.join(path.dirname(target), ".flick-export-"));
    const segments = Array.from({ length: workers }, (_, index) => ({
      file: path.join(temporary!, `segment-${index}.mp4`),
      from: Math.floor((frames * index) / workers),
      to: Math.floor((frames * (index + 1)) / workers),
    }));
    let done = 0;
    await Promise.all(
      segments.map(async (segment) => {
        const clip = await openClip(browser!, studio.data.url, { width, height });
        const encoder = startEncoder({ output: segment.file, fps: request.fps, width, height, frames: segment.to - segment.from, input: request.draft ? "mjpeg" : "png", cwd: root });
        encoders.push(encoder);
        try {
          for (let frame = segment.from; frame < segment.to; frame++) {
            check();
            await encoder.write(await clip.frame(Math.min(info.durationMs, (frame * 1000) / request.fps), request.draft ? "jpeg" : "png"));
            context.onProgress?.(++done, frames);
          }
          await encoder.finish();
        } finally {
          await clip.close().catch(() => {});
        }
      }),
    );
    check();
    const joined = path.join(temporary, "joined.mp4");
    const list = path.join(temporary, "segments.txt");
    await writeFile(list, segments.map((segment) => `file '${segment.file.replace(/'/g, "'\\''")}'`).join("\n"));
    await concatSegments(segments.map((segment) => segment.file), list, joined, root);
    check();
    // Narration or other sound attached to the scene. A missing file is reported, not fatal.
    const durationMs = (frames * 1000) / request.fps;
    const warnings: string[] = [];
    const tracks: { file: string; offsetMs: number; gain: number }[] = [];
    for (const clip of studio.data.scene?.audio ?? []) {
      if (await exists(root, `${AUDIO_DIR}/${clip.file}`)) tracks.push({ ...clip, file: await resolveInside(root, `${AUDIO_DIR}/${clip.file}`) });
      else warnings.push(`${AUDIO_DIR}/${clip.file} is missing, so this scene was exported without it.`);
    }
    const wanted = request.music ? studio.data.scene?.music : undefined;
    const music = wanted && (await writeMusic(temporary, wanted, { key: `scene:${request.sceneId}`, durationMs, momentsMs: sceneMoments(studio.data.scene!.definition) }));
    let finished = joined;
    if (tracks.length || music) {
      finished = path.join(temporary, "with-audio.mp4");
      await addAudio({ video: joined, output: finished, cwd: root, durationMs, tracks, music });
    }
    try {
      await link(finished, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Fault("output-exists", `${output} appeared during the export. Choose another --output.`, output);
      throw error;
    }
    return ok({ output, fps: request.fps, frames, durationMs, width, height, workers, audio: tracks.length > 0 || !!music, elapsedMs: Date.now() - started, ...(warnings.length ? { warnings } : {}) });
  } catch (error) {
    if (signal?.aborted) return fail([{ code: "export-cancelled", message: "Export cancelled. No file was written." }]);
    return fail(toIssues(error, "export-failed"));
  } finally {
    signal?.removeEventListener("abort", abort);
    for (const encoder of encoders) encoder.kill();
    await browser?.close().catch(() => {});
    if (temporary) await rm(temporary, { recursive: true, force: true });
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
    const source = `src/flick/scenes/${parsed.data.sceneId}.scene.json`;
    const original = await readText(context.root, source);
    if (original === undefined) throw new Fault("unknown-scene", `${source} was not found.`, source);
    const recipe = SceneRecipeSchema.parse(JSON.parse(original));
    const height = Math.max(64, Math.round((SNAPSHOT_WIDTH * recipe.definition.height) / recipe.definition.width));
    browser = await launchBrowser();
    const clip = await openClip(browser, studio.data.url, { width: SNAPSHOT_WIDTH, height });
    const timeMs = parsed.data.timeMs ?? clip.info.durationMs / 2;
    if (timeMs > clip.info.durationMs) throw new Fault("invalid-snapshot", `--time must be within the scene (0 to ${clip.info.durationMs} ms).`);
    const png = await clip.frame(timeMs, "png");
    const image = `data:image/png;base64,${png.toString("base64")}`;
    const next = SceneRecipeSchema.safeParse({ ...JSON.parse(original), snapshot: { image, timeMs } });
    if (!next.success) throw new Fault("snapshot-too-large", "The snapshot is too large to store in the recipe. Simplify the frame or pick another --time.");
    // The scene may have been edited while the browser was open; never clobber that edit.
    if ((await readText(context.root, source)) !== original) throw new Fault("source-changed", `${source} changed during the snapshot. Run it again.`, source);
    await writeText(context.root, source, `${JSON.stringify({ ...JSON.parse(original), snapshot: { image, timeMs } }, null, 2)}\n`);
    return ok({ sceneId: recipe.id, source, timeMs, bytes: png.length });
  } catch (error) {
    return fail(toIssues(error, "snapshot-failed"));
  } finally {
    await browser?.close().catch(() => {});
  }
}
