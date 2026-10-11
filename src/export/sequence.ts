import { randomBytes } from "node:crypto";
import { link, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { AUDIO_DIR, EXPORTS_DIR, ExportSequenceSchema, fail, ok, planSequence, zodIssues, type ExportSequenceResult, type Result } from "../core";
import { Fault, exists, readSequence, resolveInside, toIssues } from "../project";
import { joinClips } from "./ffmpeg";
import { writeMusic } from "./music";
import { exportScene, type ExportContext } from "./operations";
import { exportTake } from "./take";

/** Export a sequence: render each clip at the sequence's size and frame rate with the
 * ordinary scene and take exporters, then join the results with cuts or cross-fades.
 */
export async function exportSequence(input: unknown, context: ExportContext): Promise<Result<ExportSequenceResult>> {
  const parsed = ExportSequenceSchema.safeParse(input);
  if (!parsed.success) return fail(zodIssues(parsed.error, "invalid-export"));
  const request = parsed.data;
  const started = Date.now();
  const { root, signal } = context;
  const work = `${EXPORTS_DIR}/.flick-sequence-${randomBytes(4).toString("hex")}`;
  try {
    const loaded = await readSequence(request.sequenceId, context);
    if (!loaded.ok) return loaded;
    const sequence = loaded.data;
    if (request.output && (await exists(root, request.output)))
      throw new Fault("output-exists", `${request.output} already exists. Choose another --output; Flick never overwrites a file.`, request.output);
    let output = request.output;
    for (let n = 1; !output; n++) {
      const candidate = `${EXPORTS_DIR}/${sequence.id}${n === 1 ? "" : `-${n}`}.mp4`;
      if (!(await exists(root, candidate))) output = candidate;
    }
    const target = await resolveInside(root, output);
    await mkdir(await resolveInside(root, work), { recursive: true });

    // A clip used twice is rendered once.
    const rendered = new Map<string, { file: string; durationMs: number; hasAudio: boolean }>();
    const unique = [...new Map(sequence.items.map((item) => [`${item.clip.kind}:${item.clip.id}`, item.clip])).values()];
    for (const [index, clip] of unique.entries()) {
      if (signal?.aborted) throw new Fault("export-cancelled", "Export cancelled. No file was written.");
      const file = `${work}/clip-${index}.mp4`;
      // With music over the whole sequence, a clip's own music would play on top of it.
      const shared = { url: request.url, output: file, fps: sequence.fps, width: sequence.width, height: sequence.height, music: !sequence.music };
      const onProgress = (done: number, total: number) => context.onProgress?.(Math.round(((index + done / total) / unique.length) * 1000), 1000);
      const result = clip.kind === "scene" ? await exportScene({ ...shared, sceneId: clip.id }, { ...context, onProgress }) : await exportTake({ ...shared, takeId: clip.id }, { ...context, onProgress });
      if (!result.ok) return fail(result.issues.map((issue) => ({ ...issue, message: `${clip.kind} "${clip.id}": ${issue.message}` })));
      rendered.set(`${clip.kind}:${clip.id}`, { file: await resolveInside(root, file), durationMs: result.data.durationMs, hasAudio: result.data.audio });
    }
    const clips = sequence.items.map((item) => rendered.get(`${item.clip.kind}:${item.clip.id}`)!);
    const plan = planSequence(sequence.items, clips.map((clip) => clip.durationMs));
    const overlay = [];
    for (const track of sequence.audio ?? []) {
      if (!(await exists(root, `${AUDIO_DIR}/${track.file}`))) throw new Fault("missing-audio", `${AUDIO_DIR}/${track.file} does not exist. Add the file or remove it from the sequence.`);
      overlay.push({ ...track, file: await resolveInside(root, `${AUDIO_DIR}/${track.file}`) });
    }
    // The music marks each join between clips with a soft accent.
    const music = sequence.music && (await writeMusic(await resolveInside(root, work), sequence.music, { key: `sequence:${sequence.id}`, durationMs: plan.totalMs, momentsMs: plan.startsMs.slice(1).map((start, index) => start + plan.fadesMs[index + 1]! / 2), accentLevel: 1 }));
    const joined = path.join(await resolveInside(root, work), "sequence.mp4");
    const { audio } = await joinClips({ clips, fadesMs: plan.fadesMs, fps: sequence.fps, width: sequence.width, height: sequence.height, overlay, music, totalMs: plan.totalMs, output: joined, cwd: root });
    if (signal?.aborted) throw new Fault("export-cancelled", "Export cancelled. No file was written.");
    try {
      await link(joined, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Fault("output-exists", `${output} appeared during the export. Choose another --output.`, output);
      throw error;
    }
    return ok({ output, fps: sequence.fps, durationMs: Math.round(plan.totalMs), width: sequence.width, height: sequence.height, items: sequence.items.length, audio, elapsedMs: Date.now() - started });
  } catch (error) {
    if (signal?.aborted) return fail([{ code: "export-cancelled", message: "Export cancelled. No file was written." }]);
    return fail(toIssues(error, "export-failed"));
  } finally {
    await rm(await resolveInside(root, work), { recursive: true, force: true }).catch(() => {});
  }
}
