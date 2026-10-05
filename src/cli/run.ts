import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { ADAPTERS, EXPORT_FPS, PROJECT_FILE, formatGuide, getGuide, type Adapter, type Issue, type Result } from "../core";
import { exportScene, ffmpegVersion, launchBrowser, snapshotScene } from "../export";
import { initProject, listScenes, readProject, resolveStudio, syncProject } from "../project";

/** The command line: parse arguments, call one operation, print its result.
 * `--json` prints the operation result and nothing else; human output is a formatter
 * over the same result, so the two can never disagree.
 */
export type Io = { cwd: string; out(text: string): void; err(text: string): void; signal?: AbortSignal; version: string };

const HELP = `flick <command> [options]

  init [--adapter ${ADAPTERS.join("|")}]   Connect this app to Flick
  guide                                    Print the scene authoring guide
  scenes                                   List scenes and validation issues
  sync                                     Regenerate the scene catalog (Next.js, generic React)
  open [--scene <id>] [--url <origin>]     Open the studio in your browser
  snapshot --scene <id> [--time <ms>]      Save a thumbnail into the recipe
  export --scene <id> [--fps ${EXPORT_FPS.join("|")}] [--size WxH] [--output file.mp4] [--draft] [--workers n]
  doctor                                   Check Node, FFmpeg, Chromium and the project

  Every command accepts --json. --url is your dev server origin and is remembered.
`;

const OPTIONS = {
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  adapter: { type: "string" },
  scene: { type: "string" },
  url: { type: "string" },
  time: { type: "string" },
  fps: { type: "string" },
  size: { type: "string" },
  output: { type: "string", short: "o" },
  draft: { type: "boolean" },
  workers: { type: "string" },
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
        lines.push(`Studio: ${data.studioUrl} (with your dev server running)`, "", "Give your coding agent this prompt:", "", `  ${data.prompt}`);
        return lines.join("\n");
      });
    }
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
      if (!values.scene) return print(usage("export needs --scene <id>."), String);
      const size = values.size === undefined ? undefined : /^(\d+)x(\d+)$/.exec(values.size);
      if (size === null) return print(usage("--size must look like 1920x1080."), String);
      const url = await devUrl(io.cwd, values.url);
      if (!url) return print(usage(NO_URL), String);
      let shown = -1;
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
      return print(result, (data) => `Wrote ${data.output}: ${data.width}x${data.height}, ${data.fps} fps, ${data.frames} frames, ${(data.durationMs / 1000).toFixed(2)} s (rendered in ${(data.elapsedMs / 1000).toFixed(1)} s with ${data.workers} worker${data.workers === 1 ? "" : "s"}).`);
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
  checks.push({ name: "FFmpeg", ok: !!ffmpeg, detail: ffmpeg ?? "not found on PATH; needed for export" });
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
