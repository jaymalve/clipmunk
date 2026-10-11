import { exportScene, exportSequence, exportTake, snapshotScene } from "../export";
import { readProject } from "../project";
import { type Command, type Invocation, number, plural } from "./invocation";

/** The commands that render: a thumbnail, or an MP4 of a scene, a take or a sequence. */
const NO_URL = "This app is not connected to Clipmunk yet. Run npx clipmunk init, or pass your dev server with --url.";
const seconds = (ms: number) => (ms / 1000).toFixed(2);
const took = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** The dev server to render from: `--url`, or the one remembered for this project. */
async function devUrl({ io, values }: Invocation): Promise<string | undefined> {
  return values.url ?? (await readProject(io.cwd).catch(() => undefined))?.devUrl;
}

/** A progress callback that prints one line per ten percent, and nothing under `--json`. */
function progress({ io, human }: Invocation, describe: (done: number, total: number) => string) {
  let shown = -1;
  return (done: number, total: number) => {
    const percent = Math.floor((done / total) * 10) * 10;
    if (!human || percent === shown) return;
    shown = percent;
    io.err(`  ${String(percent).padStart(3)}%${describe(done, total)}`);
  };
}
const frames = (done: number, total: number) => `  ${done}/${total} frames`;

export const snapshot: Command = async (invocation) => {
  const { values, context, print, usage } = invocation;
  if (!values.scene) return usage("snapshot needs --scene <id>.");
  const url = await devUrl(invocation);
  if (!url) return usage(NO_URL);
  const result = await snapshotScene({ sceneId: values.scene, url, timeMs: number(values.time) }, context);
  return print(result, (data) => `Saved a snapshot at ${Math.round(data.timeMs)} ms into ${data.source}.`);
};

export const exportClip: Command = async (invocation) => {
  const { values, context, print, usage } = invocation;
  if (!values.scene && !values.take && !values.sequence)
    return usage("export needs --scene <id>, --take <id> or --sequence <id>.");
  const size = values.size === undefined ? undefined : /^(\d+)x(\d+)$/.exec(values.size);
  if (size === null) return usage("--size must look like 1920x1080.");
  const url = await devUrl(invocation);
  if (!url) return usage(NO_URL);
  const shared = { url, output: values.output };
  const sized = {
    ...shared,
    fps: number(values.fps),
    width: size ? Number(size[1]) : undefined,
    height: size ? Number(size[2]) : undefined,
  };

  if (values.sequence) {
    const result = await exportSequence(
      { ...shared, sequenceId: values.sequence },
      { ...context, onProgress: progress(invocation, () => "") },
    );
    return print(result, (data) => {
      const sound = data.audio ? ", with sound" : "";
      return `Wrote ${data.output}: ${plural(data.items, "clip")}, ${data.width}x${data.height}, ${data.fps} fps, ${seconds(data.durationMs)} s${sound} (rendered in ${took(data.elapsedMs)}).`;
    });
  }
  if (values.take) {
    const result = await exportTake(
      { ...sized, takeId: values.take },
      { ...context, onProgress: progress(invocation, frames) },
    );
    return print(result, (data) => {
      const sound = data.audio ? ", with sound" : "";
      return `Wrote ${data.output}: ${data.width}x${data.height}, ${data.fps} fps, ${data.frames} frames, ${seconds(data.durationMs)} s${sound} (rendered in ${took(data.elapsedMs)}).`;
    });
  }
  const result = await exportScene(
    { ...sized, sceneId: values.scene, draft: values.draft, workers: number(values.workers) },
    { ...context, onProgress: progress(invocation, frames) },
  );
  return print(result, (data) => {
    const sound = data.audio ? ", with sound" : "";
    const warnings = data.warnings?.length
      ? `\n\n${data.warnings.map((warning) => `  Warning: ${warning}`).join("\n")}`
      : "";
    return `Wrote ${data.output}: ${data.width}x${data.height}, ${data.fps} fps, ${data.frames} frames, ${seconds(data.durationMs)} s${sound} (rendered in ${took(data.elapsedMs)} with ${plural(data.workers, "worker")}).${warnings}`;
  });
};
