import { mkdir, mkdtemp, stat } from "node:fs/promises";
import path from "node:path";
import {
  buildTimeMap,
  EXPORTS_DIR,
  type ExportFormat,
  type ExportJobResult,
  ExportJobSchema,
  type ExportOutput,
  fail,
  formatVariant,
  ok,
  parseEvents,
  parseVariant,
  type Ratio,
  type Result,
  ratioCanvas,
  ratioToken,
  type SceneVariant,
  sceneMoments,
  TAKES_DIR,
  TakeEventSchema,
  takeMoments,
  variantToken,
  zodIssues,
} from "../core";
import {
  Fault,
  loadTake,
  readConfig,
  readProject,
  readSpeech,
  readText,
  resolveInside,
  resolveStudio,
  toIssues,
} from "../project";
import { makeGif, posterFrame, probeVideo } from "./ffmpeg";
import type { ExportContext } from "./operations";
import { exportScene } from "./operations";
import { CANCELLED, cancellation, claimOutput, even, noteExport, publish, removeDirectory } from "./output";
import { exportSequence } from "./sequence";
import { exportTake } from "./take";

/** An export job with several outputs: each format in each ratio. The MP4 of a ratio is rendered
 * once, by the ordinary scene, take or sequence exporter, and the GIF and poster are made from it.
 * Everything is made in one work directory and published at the end, so a failed or cancelled job
 * publishes nothing.
 */
const GIF_STEPS: { fps: number; shortSide: number }[] = [
  { fps: 15, shortSide: 720 },
  { fps: 12, shortSide: 720 },
  { fps: 10, shortSide: 720 },
  { fps: 8, shortSide: 720 },
  { fps: 8, shortSide: 540 },
  { fps: 8, shortSide: 480 },
  { fps: 8, shortSide: 360 },
  { fps: 8, shortSide: 270 },
  { fps: 8, shortSide: 180 },
];
const EXTENSIONS: Record<ExportFormat, string> = { mp4: ".mp4", gif: ".gif", poster: ".png" };

export async function exportJob(input: unknown, context: ExportContext): Promise<Result<ExportJobResult>> {
  const parsed = ExportJobSchema.safeParse(input);
  if (!parsed.success) return fail(zodIssues(parsed.error, "invalid-export"));
  const job = parsed.data;
  const started = Date.now();
  const { root } = context;
  const cancel = cancellation(context.signal);
  let directory: string | undefined;
  try {
    // A preset's export options fill in what the job leaves out.
    let options: { size?: string; fps?: number; formats?: ExportFormat[]; ratios?: Ratio[] } = {};
    const config = await readConfig(root);
    if (job.preset) {
      if (!config.ok) return config;
      const preset = config.data.config.presets?.[job.preset];
      if (!preset)
        throw new Fault("unknown-preset", `No preset named "${job.preset}" in clipmunk.config.json.`, job.preset);
      options = preset.export ?? {};
    }
    const formats = [...new Set(job.formats ?? options.formats ?? ["mp4"])];
    const ratios = job.ratios ?? (job.clip.kind !== "sequence" ? options.ratios : undefined);
    const size = job.size ?? options.size;
    const fps = (job.fps ?? options.fps) as 30 | 60 | undefined;
    if (job.variants && job.clip.kind !== "scene")
      throw new Fault(
        "variants-unsupported",
        `Themes and locales are scene variants. A ${job.clip.kind} has only ratios.`,
        "variants",
      );
    if (ratios && job.clip.kind === "sequence")
      throw new Fault("ratios-unsupported", "A sequence is rendered in its own shape.", "ratios");
    const configured = config.ok ? config.data.config.variants : undefined;
    // Scenes render on the host's dev server; takes need nothing from it.
    const url = job.url ?? (await readProject(root).catch(() => undefined))?.devUrl ?? "http://127.0.0.1:5173";
    const looks = (job.variants ?? [""]).map((text) => lookOf(text, configured));

    await mkdir(await resolveInside(root, EXPORTS_DIR), { recursive: true });
    directory = await mkdtemp(path.join(await resolveInside(root, EXPORTS_DIR), ".clipmunk-job-"));
    const relative = path.relative(root, directory).split(path.sep).join("/");
    const combos = (ratios ? [...new Set(ratios)] : [undefined]).flatMap((ratio) =>
      looks.map((look) => ({ ratio, look })),
    );
    const stepsPer = 1 + formats.filter((format) => format !== "mp4").length;
    const total = combos.length * stepsPer * 100;
    let doneSteps = 0;
    const report = (fraction: number) =>
      context.onProgress?.(Math.round((doneSteps + Math.min(1, fraction)) * 100), total);

    const made: { file: string; stem: string; format: ExportFormat; output: Omit<ExportOutput, "output"> }[] = [];
    for (const { ratio, look } of combos) {
      cancel.check();
      const token = variantToken(look);
      const stem = [job.clip.id, ratio && ratioToken(ratio), token].filter(Boolean).join(".");
      const video = `${relative}/${stem}.mp4`;
      const rendered = await renderVideo(job.clip, video, { url, size, fps, ratio, look }, context, (done, all) =>
        report(done / Math.max(1, all)),
      );
      if (!rendered.ok) return rendered;
      doneSteps++;
      const file = path.join(root, video);
      const info = await probeVideo(video, root);
      if (formats.includes("mp4"))
        made.push({
          file,
          stem,
          format: "mp4",
          output: {
            format: "mp4",
            ...(ratio ? { ratio } : {}),
            width: info.width,
            height: info.height,
            durationMs: rendered.data.durationMs,
            fps: rendered.data.fps,
            bytes: (await stat(file)).size,
          },
        });
      if (formats.includes("gif")) {
        cancel.check();
        const gif = path.join(directory, `${stem}.gif`);
        let chosen = GIF_STEPS[0]!,
          bytes = 0;
        for (const step of GIF_STEPS) {
          chosen = step;
          await makeGif(file, gif, { ...step, cwd: root, signal: context.signal });
          cancel.check();
          bytes = (await stat(gif)).size;
          if (bytes <= job.gifMaxBytes) break;
        }
        const scale = Math.min(1, chosen.shortSide / Math.min(info.width, info.height));
        const fits = bytes <= job.gifMaxBytes;
        made.push({
          file: gif,
          stem,
          format: "gif",
          output: {
            format: "gif",
            ...(ratio ? { ratio } : {}),
            width: even(info.width * scale),
            height: even(info.height * scale),
            durationMs: rendered.data.durationMs,
            fps: chosen.fps,
            bytes,
            note: `${chosen.fps} fps, ${Math.min(chosen.shortSide, Math.min(info.width, info.height))} px on the short side${fits ? "" : `, still over the ${mb(job.gifMaxBytes)} limit at the smallest setting`}`,
          },
        });
        doneSteps++;
        report(0);
      }
      if (formats.includes("poster")) {
        cancel.check();
        const wanted = job.posterAtMs ?? (await keyMoment(job.clip, url, context));
        const atMs = Math.max(0, Math.min(wanted, rendered.data.durationMs - 1000 / rendered.data.fps));
        const png = path.join(directory, `${stem}.png`);
        await posterFrame(file, png, atMs, { cwd: root, signal: context.signal });
        made.push({
          file: png,
          stem,
          format: "poster",
          output: {
            format: "poster",
            ...(ratio ? { ratio } : {}),
            width: info.width,
            height: info.height,
            atMs: Math.round(atMs),
            bytes: (await stat(png)).size,
          },
        });
        doneSteps++;
        report(0);
      }
    }
    cancel.check();
    // Publish everything only now, each under a name that overwrites nothing.
    const outputs: ExportOutput[] = [];
    for (const item of made) {
      const claim = await claimOutput(root, undefined, item.stem, EXTENSIONS[item.format]);
      await publish(item.file, claim);
      outputs.push({ output: claim.output, ...item.output });
    }
    await noteExport(
      context,
      job.clip,
      outputs.map((item) => item.output),
    );
    return ok({ outputs, elapsedMs: Date.now() - started });
  } catch (error) {
    return fail(cancel.cancelled() ? [CANCELLED] : toIssues(error, "export-failed"));
  } finally {
    cancel.release();
    await removeDirectory(directory);
  }
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** One MP4 of the clip, by its own exporter. `size` gives the short side when a ratio sets the shape. */
async function renderVideo(
  clip: { kind: "scene" | "take" | "sequence"; id: string },
  output: string,
  options: { url: string; size?: string; fps?: 30 | 60; ratio?: Ratio; look: SceneVariant },
  context: ExportContext,
  onProgress: (done: number, total: number) => void,
): Promise<Result<{ durationMs: number; fps: number }>> {
  const inner = { root: context.root, signal: context.signal, onProgress, manifest: false as const };
  if (clip.kind === "sequence") return exportSequence({ sequenceId: clip.id, url: options.url, output }, inner);
  const [width, height] = options.size ? options.size.split("x").map(Number) : [];
  let dimensions: { width?: number; height?: number } = width && height ? { width, height } : {};
  if (options.ratio && width && height) {
    const shape = ratioCanvas(options.ratio);
    const scale = Math.min(width, height) / Math.min(shape.width, shape.height);
    dimensions = { width: even(shape.width * scale), height: even(shape.height * scale) };
  }
  if (clip.kind === "take")
    return exportTake(
      {
        takeId: clip.id,
        url: options.url,
        output,
        ...dimensions,
        ...(options.fps ? { fps: options.fps } : {}),
        ratio: options.ratio,
      },
      inner,
    );
  // A scene's ratio is a variant: its own frame size when the recipe has one, otherwise fitted.
  const variant = formatVariant({ ...options.look, ...(options.ratio ? { ratio: options.ratio } : {}) });
  return exportScene(
    {
      sceneId: clip.id,
      url: options.url,
      output,
      ...dimensions,
      ...(options.fps ? { fps: options.fps } : {}),
      ...(variant ? { variant } : {}),
    },
    inner,
  );
}

/** Where a poster is taken by default: a take's first click, a scene's first key moment, a sequence's start. */
async function keyMoment(
  clip: { kind: "scene" | "take" | "sequence"; id: string },
  url: string,
  context: ExportContext,
): Promise<number> {
  if (clip.kind === "take") {
    const loaded = await loadTake(context.root, clip.id);
    if (!loaded.ok) return 0;
    const take = loaded.data.take;
    const events = parseEvents(
      (await readText(context.root, `${TAKES_DIR}/${take.id}/${take.source.events.file}`)) ?? "",
      TakeEventSchema,
    );
    const map = buildTimeMap(take.edit, events, await readSpeech(context.root, take).catch(() => []));
    return takeMoments(map, events)[0] ?? 0;
  }
  if (clip.kind === "scene") {
    const studio = await resolveStudio({ url, sceneId: clip.id }, context);
    return studio.ok && studio.data.scene ? (sceneMoments(studio.data.scene.definition)[0] ?? 0) : 0;
  }
  return 0;
}

/** A job's variant: "theme:dark,locale:de", or a bare value from the config's themes or locales. */
function lookOf(text: string, configured: { themes?: string[]; locales?: string[] } | undefined): SceneVariant {
  if (!text) return {};
  if (text.includes(":")) {
    const { ratio: _ratio, ...look } = parseVariant(text);
    if (!look.theme && !look.locale) throw new Fault("invalid-variant", `"${text}" is not a theme or a locale.`, text);
    return look;
  }
  if (configured?.themes?.includes(text)) return { theme: text };
  if (configured?.locales?.includes(text)) return { locale: text };
  throw new Fault(
    "unknown-variant",
    `"${text}" is not one of the themes or locales in clipmunk.config.json. Write theme:${text} or locale:${text} to use it anyway.`,
    text,
  );
}
