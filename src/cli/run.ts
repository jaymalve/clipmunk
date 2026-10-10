import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { ADAPTERS, DAEMON_HASH, EXPORT_FPS, PROJECT_FILE, formatGuide, getGuide, resolveZoomTracks, studioUrl, zoomSegments, type Adapter, type Issue, type Result } from "../core";
import { listTakes, readTake, readTakeEvents, startDaemon, updateTakeEdit } from "../daemon";
import { MISSING_FFMPEG, exportScene, exportSequence, exportTake, ffmpegVersion, launchBrowser, snapshotScene } from "../export";
import { initProject, listScenes, listSequences, readProject, resolveStudio, syncProject } from "../project";

/** The command line: parse arguments, call one operation, print its result.
 * `--json` prints the operation result and nothing else; human output is a formatter
 * over the same result, so the two can never disagree.
 */
export type Io = { cwd: string; out(text: string): void; err(text: string): void; signal?: AbortSignal; version: string };

const HELP = `flick <command> [options]

  init [--adapter ${ADAPTERS.join("|")}]   Connect this app to Flick
  dev [--port <n>]                         Start the local daemon for recording and studio exports
  guide                                    Print the scene authoring guide
  scenes                                   List scenes and validation issues
  takes                                    List recorded takes
  sync                                     Regenerate the scene catalog (Next.js, generic React)
  open [--scene <id>] [--url <origin>]     Open the studio in your browser
  snapshot --scene <id> [--time <ms>]      Save a thumbnail into the recipe
  export --scene <id> [--fps ${EXPORT_FPS.join("|")}] [--size WxH] [--output file.mp4] [--draft] [--workers n]
  export --take <id> [--fps 30|60] [--size WxH] [--output file.mp4]
  export --sequence <id> [--output file.mp4]
  sequences                                List sequences (scenes and takes joined into one video)
  zoom <take> [--write]                    Show a take's automatic zooms, or store them for hand editing
  doctor                                   Check Node, FFmpeg, Chromium and the project

  Every command accepts --json. --url is your dev server origin and is remembered.
`;

const OPTIONS = {
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  adapter: { type: "string" },
  scene: { type: "string" },
  take: { type: "string" },
  sequence: { type: "string" },
  write: { type: "boolean" },
  url: { type: "string" },
  time: { type: "string" },
  fps: { type: "string" },
  size: { type: "string" },
  output: { type: "string", short: "o" },
  draft: { type: "boolean" },
  workers: { type: "string" },
  port: { type: "string" },
  "no-launch": { type: "boolean" },
} as const;

const usage = (message: string): Result<never> => ({ ok: false, issues: [{ code: "usage", message }] });
const number = (value: string | undefined) => (value === undefined ? undefined : Number(value));

export async function run(argv: string[], io: Io): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (error) {
    io.err(`${(error as Error).message}\n\n${HELP}`);
    return 1;
  }
  const { values, positionals } = parsed;
  const [command] = positionals;
  if (values.version) return io.out(io.version), 0;
  if (values.help || !command) return io.out(HELP), command || values.help ? 0 : 1;
  const context = { root: io.cwd, signal: io.signal };
  const human = !values.json;
  const print = <T>(result: Result<T>, format: (data: T) => string): number => {
    if (!human) io.out(JSON.stringify(result, null, 2));
    else if (result.ok) io.out(format(result.data));
    else io.err(formatIssues(result.issues));
    return result.ok ? 0 : 1;
  };

  switch (command) {
    case "init": {
      if (values.adapter && !ADAPTERS.includes(values.adapter as Adapter)) return print(usage(`--adapter must be one of: ${ADAPTERS.join(", ")}`), String);
      return print(await initProject({ adapter: values.adapter as Adapter | undefined }, context), (data) => {
        const lines = [`Connected Flick (${data.adapter}).`, ""];
        for (const file of data.files) lines.push(`  ${file.status.padEnd(8)} ${file.path}`);
        if (data.entry.status === "wrapped") lines.push(`  wrapped  ${data.entry.path}`);
        if (data.entry.status === "already") lines.push(`  verified ${data.entry.path}`);
        lines.push("");
        if (data.entry.status === "manual") lines.push(data.entry.instruction!, "");
        if (data.recorder.instruction && data.entry.status !== "manual") lines.push(data.recorder.instruction, "");
        lines.push(`Studio: ${data.studioUrl} (with your dev server running)`, "To record your app: npx flick dev", "", "Give your coding agent this prompt:", "", `  ${data.prompt}`);
        return lines.join("\n");
      });
    }
    case "dev": {
      const port = number(values.port);
      if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) return print(usage("--port must be a port number (0 picks any free port)."), String);
      let daemon;
      try {
        daemon = await startDaemon({ root: io.cwd, port, version: io.version, log: (line) => human && io.err(`  ${line}`) });
      } catch (error) {
        return print(usage((error as NodeJS.ErrnoException).code === "EADDRINUSE" ? `Port ${port} is already in use.` : `The daemon could not start: ${(error as Error).message}`), String);
      }
      // Saving a recording and exporting both need FFmpeg; say so now, not after the first take.
      if (human && !(await ffmpegVersion())) io.err(`\nWarning: ${MISSING_FFMPEG}\nRecordings cannot be saved until it is available. Restart flick dev afterwards.\n`);
      const project = await readProject(io.cwd).catch(() => undefined);
      const link = `${project ? studioUrl(project.devUrl, project.studioPath) : "http://127.0.0.1:5173/?flick=1"}#${DAEMON_HASH}=${daemon.port}.${daemon.token}`;
      if (human) io.out(`Flick daemon listening on ${daemon.origin}\n\nOpen this link once to connect your browser (your dev server must be running):\n\n  ${link}\n\nThen press Alt+Shift+R on any page of your app to record. Ctrl+C stops the daemon.`);
      else io.out(JSON.stringify({ ok: true, data: { port: daemon.port, token: daemon.token, link } }));
      await new Promise<void>((resolve) => (io.signal?.aborted ? resolve() : io.signal?.addEventListener("abort", () => resolve(), { once: true })));
      await daemon.close();
      return 0;
    }
    case "sequences": {
      const result = await listSequences(context);
      const code = print(result, (data) =>
        [
          ...(data.sequences.length
            ? data.sequences.map((sequence) => `  ${sequence.id.padEnd(24)} ${String(sequence.items.length).padStart(2)} clip${sequence.items.length === 1 ? " " : "s"}  ${sequence.width}x${sequence.height}@${sequence.fps}  ${sequence.title}`)
            : ["  No sequences yet. Create src/flick/sequences/<id>.sequence.json (see flick guide) or build one in the studio."]),
          ...(data.issues.length ? ["", formatIssues(data.issues)] : []),
        ].join("\n"),
      );
      return result.ok && result.data.issues.length ? 1 : code;
    }
    case "takes":
      return print(await listTakes(context), (data) =>
        [
          ...(data.takes.length
            ? data.takes.map((take) => `  ${take.id.padEnd(24)} ${(take.durationMs / 1000).toFixed(1).padStart(6)} s  ${take.width}x${take.height}${take.hasCam ? "  cam" : ""}${take.hasAudio ? "  voice" : ""}  ${take.title}`)
            : ["  No takes yet. Run flick dev, open its link, then press Alt+Shift+R in your app."]),
          ...(data.issues.length ? ["", formatIssues(data.issues)] : []),
        ].join("\n"),
      );
    case "guide":
      io.out(human ? formatGuide() : JSON.stringify(getGuide(), null, 2));
      return 0;
    case "scenes": {
      const result = await listScenes(context);
      const code = print(result, (catalog) => {
        const lines = catalog.scenes.length
          ? catalog.scenes.map((scene) => `  ${scene.id.padEnd(24)} ${scene.title}${scene.snapshot ? "" : "  (no snapshot)"}`)
          : ["  No scenes yet. Create a pair in src/flick/scenes; see flick guide."];
        if (catalog.issues.length) lines.push("", formatIssues(catalog.issues));
        return lines.join("\n");
      });
      return result.ok && result.data.issues.length ? 1 : code;
    }
    case "sync":
      return print(await syncProject(context), (data) =>
        [
          data.status === "not-needed" ? "Vite discovers scenes automatically; nothing to sync." : `${data.status === "verified" ? "Up to date" : "Wrote"}: ${data.catalog} (${data.scenes} scene${data.scenes === 1 ? "" : "s"}).`,
          ...(data.issues.length ? ["", formatIssues(data.issues)] : []),
        ].join("\n"),
      );
    case "open": {
      const result = await resolveStudio({ url: values.url, sceneId: values.scene }, context);
      if (result.ok && result.data.reachable && human && !values["no-launch"]) launch(result.data.url);
      return print(
        result.ok ? { ok: true as const, data: { url: result.data.url, reachable: result.data.reachable } } : result,
        (data) => (data.reachable ? data.url : `${data.url}\n\nNothing is answering there yet. Start your dev server, or pass its address with --url.`),
      );
    }
    case "snapshot": {
      if (!values.scene) return print(usage("snapshot needs --scene <id>."), String);
      const url = await devUrl(io.cwd, values.url);
      if (!url) return print(usage(NO_URL), String);
      return print(await snapshotScene({ sceneId: values.scene, url, timeMs: number(values.time) }, context), (data) => `Saved a snapshot at ${Math.round(data.timeMs)} ms into ${data.source}.`);
    }
    case "export": {
      if (!values.scene && !values.take && !values.sequence) return print(usage("export needs --scene <id>, --take <id> or --sequence <id>."), String);
      const size = values.size === undefined ? undefined : /^(\d+)x(\d+)$/.exec(values.size);
      if (size === null) return print(usage("--size must look like 1920x1080."), String);
      const url = await devUrl(io.cwd, values.url);
      if (!url) return print(usage(NO_URL), String);
      let shown = -1;
      if (values.sequence) {
        const result = await exportSequence({ sequenceId: values.sequence, url, output: values.output }, { ...context, onProgress: (done, total) => {
          const percent = Math.floor((done / total) * 10) * 10;
          if (human && percent !== shown) io.err(`  ${String((shown = percent)).padStart(3)}%`);
        } });
        return print(result, (data) => `Wrote ${data.output}: ${data.items} clip${data.items === 1 ? "" : "s"}, ${data.width}x${data.height}, ${data.fps} fps, ${(data.durationMs / 1000).toFixed(2)} s${data.audio ? ", with sound" : ""} (rendered in ${(data.elapsedMs / 1000).toFixed(1)} s).`);
      }
      if (values.take) {
        const result = await exportTake(
          { takeId: values.take, url, output: values.output, fps: number(values.fps), width: size ? Number(size[1]) : undefined, height: size ? Number(size[2]) : undefined },
          { ...context, onProgress: (done, total) => {
            const percent = Math.floor((done / total) * 10) * 10;
            if (human && percent !== shown) io.err(`  ${String((shown = percent)).padStart(3)}%  ${done}/${total} frames`);
          } },
        );
        return print(result, (data) => `Wrote ${data.output}: ${data.width}x${data.height}, ${data.fps} fps, ${data.frames} frames, ${(data.durationMs / 1000).toFixed(2)} s${data.audio ? ", with voice" : ""} (rendered in ${(data.elapsedMs / 1000).toFixed(1)} s).`);
      }
      const result = await exportScene(
        { sceneId: values.scene, url, output: values.output, fps: number(values.fps), width: size && Number(size[1]), height: size && Number(size[2]), draft: values.draft, workers: number(values.workers) },
        {
          ...context,
          onProgress: (done, total) => {
            const percent = Math.floor((done / total) * 10) * 10;
            if (human && percent !== shown) io.err(`  ${String((shown = percent)).padStart(3)}%  ${done}/${total} frames`);
          },
        },
      );
      return print(result, (data) => `Wrote ${data.output}: ${data.width}x${data.height}, ${data.fps} fps, ${data.frames} frames, ${(data.durationMs / 1000).toFixed(2)} s ${data.audio ? ", with sound" : ""} (rendered in ${(data.elapsedMs / 1000).toFixed(1)} s with ${data.workers} worker${data.workers === 1 ? "" : "s"}).${data.warnings?.length ? `\n\n${data.warnings.map((warning) => `  Warning: ${warning}`).join("\n")}` : ""}`);
    }
    case "zoom": {
      const id = positionals[1] ?? values.take;
      if (!id) return print(usage("zoom needs a take id: flick zoom <take>."), String);
      const loaded = await readTake(id, context);
      if (!loaded.ok) return print(loaded, String);
      const { take, revision } = loaded.data;
      const tracks = resolveZoomTracks(take.edit, await readTakeEvents(id, context), take.source);
      const segments = zoomSegments(tracks);
      if (!values.write) return print({ ok: true, data: { mode: take.edit.zoom.mode, segments, tracks } }, (data) =>
        [`Zoom mode: ${data.mode}`, ...(segments.length ? segments.map((segment) => `  ${(segment.startMs / 1000).toFixed(2)}s to ${(segment.endMs / 1000).toFixed(2)}s  at ${segment.scale.toFixed(2)}x`) : ["  No zooms: this take has no clicks or typing."]), "", "Run with --write to store these as editable keyframes in take.json."].join("\n"));
      const saved = await updateTakeEdit(id, { edit: { ...take.edit, zoom: { mode: "manual", tracks } }, revision }, context);
      return print(saved, () => `Stored ${segments.length} zoom${segments.length === 1 ? "" : "s"} as manual keyframes in .flick/takes/${id}/take.json.`);
    }
    case "doctor": {
      const checks = await doctor(io.cwd);
      print({ ok: true, data: checks }, (list) => list.map((check) => `  ${check.ok ? "ok  " : "FAIL"}  ${check.name}: ${check.detail}`).join("\n"));
      return checks.every((check) => check.ok) ? 0 : 1;
    }
    default:
      io.err(`Unknown command "${command}".\n\n${HELP}`);
      return 1;
  }
}

const NO_URL = "This app is not connected to Flick yet. Run npx flick init, or pass your dev server with --url.";
const formatIssues = (issues: Issue[]) => issues.map((issue) => `  ${issue.path ? `${issue.path}: ` : ""}${issue.message}`).join("\n");

async function devUrl(root: string, flag: string | undefined): Promise<string | undefined> {
  if (flag) return flag;
  return (await readProject(root).catch(() => undefined))?.devUrl;
}

function launch(url: string) {
  const [command, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  spawn(command!, args as string[], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

type Check = { name: string; ok: boolean; detail: string };
async function doctor(root: string): Promise<Check[]> {
  const checks: Check[] = [];
  const [major, minor] = process.versions.node.split(".").map(Number) as [number, number];
  checks.push({ name: "Node", ok: major > 22 || (major === 22 && minor >= 12), detail: `${process.versions.node} (needs 22.12 or newer)` });
  const ffmpeg = await ffmpegVersion();
  checks.push({ name: "FFmpeg", ok: !!ffmpeg, detail: ffmpeg ?? "not found; needed to save recordings and export. Install FFmpeg or run npm install -D ffmpeg-static" });
  const browser = await launchBrowser().then(async (instance) => {
    const version = instance.version();
    await instance.close();
    return { ok: true, detail: `Chromium ${version}` };
  }, (error: Error) => ({ ok: false, detail: error.message.split("\n")[0]! }));
  checks.push({ name: "Chromium", ...browser });
  const project = await readProject(root).then((value) => value, (error: Error) => error);
  checks.push(
    project instanceof Error
      ? { name: "Project", ok: false, detail: project.message }
      : project
        ? { name: "Project", ok: true, detail: `${project.adapter}, dev server ${project.devUrl}` }
        : { name: "Project", ok: false, detail: `${PROJECT_FILE} not found; run npx flick init` },
  );
  return checks;
}
