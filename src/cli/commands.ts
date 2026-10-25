import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import {
  ADAPTERS,
  type Adapter,
  CONFIG_FILE,
  DAEMON_FILE,
  DAEMON_HASH,
  DaemonFileSchema,
  encodeWav,
  formatGuide,
  getGuide,
  MUSIC_STYLES,
  type MusicStyle,
  PRESET_FIELDS,
  PROJECT_FILE,
  type PresetField,
  renderMusic,
  resolveZoomTracks,
  SCENE_PARAM,
  STUDIO_PARAM,
  studioUrl,
  zoomSegments,
} from "../core";
import { applyPresetToScene, listTakes, readTake, readTakeEvents, startDaemon, updateTakeEdit } from "../daemon";
import { ffmpegVersion, launchBrowser, MISSING_FFMPEG } from "../export";
import {
  applyPresetToTake,
  configWarnings,
  initProject,
  listPresets,
  listScenes,
  listSequences,
  readConfig,
  readProject,
  readText,
  refreshStateFiles,
  resolveInside,
  resolveStudio,
  savePreset,
  syncProject,
} from "../project";
import { type Command, formatIssues, number, plural } from "./invocation";

/** The commands that set a project up, list what is in it, and run the daemon. */
const withIssues = (lines: string[], issues: Parameters<typeof formatIssues>[0]) =>
  [...lines, ...(issues.length ? ["", formatIssues(issues)] : [])].join("\n");

export const init: Command = async ({ values, context, print, usage }) => {
  if (values.adapter && !ADAPTERS.includes(values.adapter as Adapter))
    return usage(`--adapter must be one of: ${ADAPTERS.join(", ")}`);
  return print(await initProject({ adapter: values.adapter as Adapter | undefined }, context), (data) => {
    const lines = [`Connected Clipmunk (${data.adapter}).`, ""];
    for (const file of data.files) lines.push(`  ${file.status.padEnd(8)} ${file.path}`);
    if (data.entry.status === "wrapped") lines.push(`  wrapped  ${data.entry.path}`);
    if (data.entry.status === "already") lines.push(`  verified ${data.entry.path}`);
    lines.push("");
    if (data.entry.status === "manual") lines.push(data.entry.instruction!, "");
    if (data.recorder.instruction && data.entry.status !== "manual") lines.push(data.recorder.instruction, "");
    lines.push(
      `Studio: ${data.studioUrl} (with your dev server running)`,
      "To record your app: npx clipmunk dev",
      "",
      "Give your coding agent this prompt:",
      "",
      `  ${data.prompt}`,
    );
    return lines.join("\n");
  });
};

export const dev: Command = async ({ io, values, human, usage }) => {
  const port = number(values.port);
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535))
    return usage("--port must be a port number (0 picks any free port).");
  let daemon: Awaited<ReturnType<typeof startDaemon>>;
  try {
    daemon = await startDaemon({
      root: io.cwd,
      port,
      version: io.version,
      log: (line) => human && io.err(`  ${line}`),
    });
  } catch (error) {
    const busy = (error as NodeJS.ErrnoException).code === "EADDRINUSE";
    return usage(busy ? `Port ${port} is already in use.` : `The daemon could not start: ${(error as Error).message}`);
  }
  // Saving a recording and exporting both need FFmpeg; say so now, not after the first take.
  if (human && !(await ffmpegVersion()))
    io.err(
      `\nWarning: ${MISSING_FFMPEG}\nRecordings cannot be saved until it is available. Restart clipmunk dev afterwards.\n`,
    );
  // Keep Clipmunk's own state files current, so an older project commits new kinds of file.
  const refreshed = await refreshStateFiles({ root: io.cwd });
  if (human && refreshed.ok) {
    for (const file of refreshed.data.updated) io.err(`  Updated ${file}.`);
    for (const issue of refreshed.data.issues) io.err(`\nNote: ${issue.message}\n`);
  }
  const project = await readProject(io.cwd).catch(() => undefined);
  const hash = `#${DAEMON_HASH}=${daemon.port}.${daemon.token}`;
  // The standalone Studio, served by the daemon itself, and the app's own pages for recording.
  const studioLink = `${daemon.origin}/${hash}`;
  const app = project ? studioUrl(project.devUrl, project.studioPath) : "http://127.0.0.1:5173/?clipmunk=1";
  const link = `${app}${hash}`;
  if (human)
    io.out(
      [
        `Clipmunk daemon listening on ${daemon.origin}`,
        "",
        "Studio:",
        "",
        `  ${studioLink}`,
        "",
        "To record your app, open this once with your dev server running, then press Alt+Shift+R on any page:",
        "",
        `  ${link}`,
        "",
        "Ctrl+C stops the daemon.",
      ].join("\n"),
    );
  else io.out(JSON.stringify({ ok: true, data: { port: daemon.port, token: daemon.token, studio: studioLink, link } }));
  // Run until interrupted.
  await new Promise<void>((resolve) =>
    io.signal?.aborted ? resolve() : io.signal?.addEventListener("abort", () => resolve(), { once: true }),
  );
  await daemon.close();
  return 0;
};

export const guide: Command = ({ io, human }) => {
  io.out(human ? formatGuide() : JSON.stringify(getGuide(), null, 2));
  return 0;
};

/** Listing commands exit non-zero while any file is broken, so they can gate a script. */
export const scenes: Command = async ({ context, print }) => {
  const result = await listScenes(context);
  const code = print(result, (catalog) => {
    const lines = catalog.scenes.length
      ? catalog.scenes.map(
          (scene) => `  ${scene.id.padEnd(24)} ${scene.title}${scene.snapshot ? "" : "  (no snapshot)"}`,
        )
      : ["  No scenes yet. Create a pair in src/clipmunk/scenes; see clipmunk guide."];
    return withIssues(lines, catalog.issues);
  });
  return result.ok && result.data.issues.length ? 1 : code;
};

export const sequences: Command = async ({ context, print }) => {
  const result = await listSequences(context);
  const code = print(result, (data) => {
    const lines = data.sequences.length
      ? data.sequences.map((sequence) => {
          const clips = `${String(sequence.items.length).padStart(2)} clip${sequence.items.length === 1 ? " " : "s"}`;
          return `  ${sequence.id.padEnd(24)} ${clips}  ${sequence.width}x${sequence.height}@${sequence.fps}  ${sequence.title}`;
        })
      : [
          "  No sequences yet. Create src/clipmunk/sequences/<id>.sequence.json (see clipmunk guide) or build one in the studio.",
        ];
    return withIssues(lines, data.issues);
  });
  return result.ok && result.data.issues.length ? 1 : code;
};

export const takes: Command = async ({ context, print }) =>
  print(await listTakes(context), (data) => {
    const lines = data.takes.length
      ? data.takes.map((take) => {
          const length = `${(take.durationMs / 1000).toFixed(1).padStart(6)} s`;
          const extras = `${take.hasCam ? "  cam" : ""}${take.hasAudio ? "  voice" : ""}`;
          return `  ${take.id.padEnd(24)} ${length}  ${take.width}x${take.height}${extras}  ${take.title}`;
        })
      : ["  No takes yet. Run clipmunk dev, open its link, then press Alt+Shift+R in your app."];
    return withIssues(lines, data.issues);
  });

export const sync: Command = async ({ context, print }) =>
  print(await syncProject(context), (data) => {
    const summary =
      data.status === "not-needed"
        ? "Vite discovers scenes automatically; nothing to sync."
        : `${data.status === "verified" ? "Up to date" : "Wrote"}: ${data.catalog} (${plural(data.scenes, "scene")}).`;
    const adapter =
      data.studio && data.studio.status !== "verified" ? [`Updated ${data.studio.path} for the frame page.`] : [];
    return withIssues([summary, ...adapter], data.issues);
  });

function launch(url: string) {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  spawn(command as string, args as string[], { stdio: "ignore", detached: true })
    .on("error", () => {})
    .unref();
}

export const open: Command = async ({ values, context, human, print }) => {
  const result = await resolveStudio({ url: values.url, sceneId: values.scene }, context);
  if (!result.ok) return print(result, String);
  // The Studio is served by the daemon; without one running, say how to start it.
  const daemon = await readDaemonFile(context.root);
  if (!daemon)
    return print(
      { ok: true, data: { url: undefined, reachable: false } },
      () => "The Studio runs with the daemon. Start it with npx clipmunk dev, then open the Studio link it prints.",
    );
  const studio = new URL(`http://127.0.0.1:${daemon.port}/`);
  studio.searchParams.set(STUDIO_PARAM, "1");
  if (values.scene) studio.searchParams.set(SCENE_PARAM, values.scene);
  studio.hash = `${DAEMON_HASH}=${daemon.port}.${daemon.token}`;
  const url = studio.toString();
  const { reachable } = result.data;
  if (human && !values["no-launch"]) launch(url);
  return print({ ok: true, data: { url, reachable } }, (data) =>
    data.reachable
      ? data.url
      : `${data.url}\n\nYour app's dev server is not answering, so scenes will not preview until it is running.`,
  );
};

async function readDaemonFile(root: string) {
  try {
    const parsed = DaemonFileSchema.safeParse(JSON.parse((await readText(root, DAEMON_FILE)) ?? "null"));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export const zoom: Command = async ({ values, args, context, print, usage }) => {
  const id = args[0] ?? values.take;
  if (!id) return usage("zoom needs a take id: clipmunk zoom <take>.");
  const loaded = await readTake(id, context);
  if (!loaded.ok) return print(loaded, String);
  const { take, revision } = loaded.data;
  const tracks = resolveZoomTracks(take.edit, await readTakeEvents(id, context), take.source);
  const segments = zoomSegments(tracks);
  if (values.write) {
    const saved = await updateTakeEdit(
      id,
      { edit: { ...take.edit, zoom: { mode: "manual", tracks } }, revision },
      context,
    );
    return print(
      saved,
      () => `Stored ${plural(segments.length, "zoom")} as manual keyframes in .clipmunk/takes/${id}/edit.json.`,
    );
  }
  const seconds = (ms: number) => `${(ms / 1000).toFixed(2)}s`;
  return print({ ok: true, data: { mode: take.edit.zoom.mode, segments, tracks } }, (data) =>
    [
      `Zoom mode: ${data.mode}`,
      ...(segments.length
        ? segments.map(
            (segment) => `  ${seconds(segment.startMs)} to ${seconds(segment.endMs)}  at ${segment.scale.toFixed(2)}x`,
          )
        : ["  No zooms: this take has no clicks or typing."]),
      "",
      "Run with --write to store these as editable keyframes in edit.json.",
    ].join("\n"),
  );
};

export const music: Command = async ({ io, values, args, print, usage }) => {
  const style = args[0] as MusicStyle | undefined;
  if (!style || !MUSIC_STYLES.includes(style)) return usage(`music needs a style: ${MUSIC_STYLES.join(", ")}.`);
  const seed = number(values.seed) ?? 1,
    seconds = number(values.seconds) ?? 20;
  if (!Number.isInteger(seed) || seed < 0 || !(seconds > 0 && seconds <= 600))
    return usage("--seed is a whole number and --seconds is between 1 and 600.");
  const output = values.output ?? `clipmunk-${style}-${seed}.wav`;
  if (!output.endsWith(".wav")) return usage("--output must end in .wav.");
  try {
    const target = await resolveInside(io.cwd, output);
    const rendered = renderMusic({ style, seed, durationMs: seconds * 1000 });
    await writeFile(target, encodeWav(rendered), { flag: "wx" });
    return print(
      { ok: true, data: { output, style, seed, seconds, bpm: rendered.bpm } },
      (data) =>
        `Wrote ${data.output}: ${data.style}, seed ${data.seed}, ${data.seconds} s at ${data.bpm} beats per minute. Generated by Clipmunk, so it is yours to use.`,
    );
  } catch (error) {
    const taken = (error as NodeJS.ErrnoException).code === "EEXIST";
    return usage(taken ? `${output} already exists. Choose another --output.` : (error as Error).message);
  }
};

type Check = { name: string; ok: boolean; detail: string };
async function checks(root: string): Promise<Check[]> {
  const [major, minor] = process.versions.node.split(".").map(Number) as [number, number];
  const ffmpeg = await ffmpegVersion();
  const browser = await launchBrowser().then(
    async (instance) => {
      const version = instance.version();
      await instance.close();
      return { ok: true, detail: `Chromium ${version}` };
    },
    (error: Error) => ({ ok: false, detail: error.message.split("\n")[0]! }),
  );
  const project = await readProject(root).then(
    (value) => value,
    (error: Error) => error,
  );
  const connection =
    project instanceof Error
      ? { ok: false, detail: project.message }
      : project
        ? { ok: true, detail: `${project.adapter}, dev server ${project.devUrl}` }
        : { ok: false, detail: `${PROJECT_FILE} not found; run npx clipmunk init` };
  const config = await readConfig(root);
  const warnings = config.ok ? await configWarnings(root, config.data.config) : [];
  const problem = config.ok ? warnings[0] : config.issues[0];
  const settings = problem
    ? { ok: false, detail: `${problem.path ? `${problem.path}: ` : ""}${problem.message}` }
    : {
        ok: true,
        detail: config.ok && config.data.exists ? `${CONFIG_FILE} is valid` : `no ${CONFIG_FILE} (optional)`,
      };
  return [
    {
      name: "Node",
      ok: major > 22 || (major === 22 && minor >= 12),
      detail: `${process.versions.node} (needs 22.12 or newer)`,
    },
    {
      name: "FFmpeg",
      ok: !!ffmpeg,
      detail:
        ffmpeg ?? "not found; needed to save recordings and export. Install FFmpeg or run npm install -D ffmpeg-static",
    },
    { name: "Chromium", ...browser },
    { name: "Project", ...connection },
    { name: "Config", ...settings },
  ];
}

export const doctor: Command = async ({ io, print }) => {
  const list = await checks(io.cwd);
  print({ ok: true, data: list }, (data) =>
    data.map((check) => `  ${check.ok ? "ok  " : "FAIL"}  ${check.name}: ${check.detail}`).join("\n"),
  );
  return list.every((check) => check.ok) ? 0 : 1;
};

/** clipmunk preset list | apply <name> --take <id> | --scene <id> | save <name> --take <id> --fields a,b */
export const preset: Command = async ({ values, args, context, print, usage }) => {
  const [action, name] = args;
  if (action === "list" || !action) {
    const listed = await listPresets(context.root);
    return print(listed, (data) =>
      data.presets.length
        ? data.presets.map((entry) => `  ${entry.name.padEnd(20)} ${entry.summary}`).join("\n")
        : `No presets yet. Save one with: clipmunk preset save <name> --take <id> --fields ${PRESET_FIELDS.join(",")}`,
    );
  }
  if (!name) return usage(`preset ${action} needs a preset name: clipmunk preset ${action} <name>.`);
  if (action === "apply") {
    if (values.scene) {
      const applied = await applyPresetToScene(values.scene, name, context);
      return print(applied, (data) =>
        data.music
          ? `Set the music of ${values.scene} to ${data.music.style}.`
          : `Removed the music of ${values.scene}.`,
      );
    }
    if (!values.take) return usage("preset apply needs --take <id> or --scene <id>.");
    const applied = await applyPresetToTake(context.root, values.take, name);
    return print(
      applied,
      () => `Applied ${name} to ${values.take}; saved in .clipmunk/takes/${values.take}/edit.json.`,
    );
  }
  if (action === "save") {
    if (!values.take) return usage("preset save needs --take <id>: the take whose settings to save.");
    const fields = (values.fields ?? "").split(",").filter(Boolean);
    const unknown = fields.filter((field) => !(PRESET_FIELDS as readonly string[]).includes(field));
    if (!fields.length || unknown.length)
      return usage(`--fields takes a comma-separated list of ${PRESET_FIELDS.join(", ")}.`);
    const saved = await savePreset(context.root, {
      name,
      fromTake: values.take,
      fields: fields as PresetField[],
      ...(values.title ? { title: values.title } : {}),
      replace: !!values.replace,
    });
    return print(saved, (data) => `Saved preset ${data.name} (${data.summary}) in ${CONFIG_FILE}.`);
  }
  return usage(`Unknown preset action "${action}". Use list, apply or save.`);
};
