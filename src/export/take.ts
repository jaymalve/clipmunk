import { open } from "node:fs/promises";
import path from "node:path";
import {
  DAEMON_HASH,
  type ExportTakeResult,
  ExportTakeSchema,
  fail,
  ok,
  parseEvents,
  type Result,
  TAKE_PARAM,
  TAKES_DIR,
  type Take,
  TakeEventSchema,
  TakeSchema,
  takeMoments,
  zodIssues,
} from "../core";
import { Fault, readText, resolveInside, resolveStudio, toIssues } from "../project";
import { launchBrowser } from "./browser";
import { finishTake } from "./ffmpeg";
import { writeMusic } from "./music";
import type { ExportContext } from "./operations";
import {
  CANCELLED,
  type Cancellation,
  cancellation,
  claimOutput,
  publish,
  removeDirectory,
  workDirectory,
} from "./output";

/** Export a take. The studio's take editor is opened in a headless page and asked to
 * render and encode every frame itself, with the same renderer the preview uses, so the
 * file matches what the editor shows. FFmpeg then adds the voice track and the music.
 */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
type Browser = Awaited<ReturnType<typeof launchBrowser>>;
type TakeRequest = ReturnType<typeof ExportTakeSchema.parse>;
type Encoded = { codec: string; frames: number; width: number; height: number; durationMs: number };

async function readTake(root: string, takeId: string): Promise<Result<Take>> {
  const source = `${TAKES_DIR}/${takeId}/take.json`;
  const text = await readText(root, source);
  if (text === undefined) throw new Fault("unknown-take", `No take named "${takeId}". Run flick takes to list them.`);
  const take = TakeSchema.safeParse(JSON.parse(text));
  if (take.success) return ok(take.data);
  return fail(zodIssues(take.error, "invalid-take").map((issue) => ({ ...issue, path: `${source}: ${issue.path}` })));
}

/** Open the take editor in a private page and have it render and encode the take into `video`. */
async function encodeInPage(options: {
  browser: Browser;
  editorUrl: string;
  studioUrl: string;
  video: string;
  request: TakeRequest;
  cancel: Cancellation;
  onProgress?: (done: number, total: number) => void;
}): Promise<Encoded> {
  const { request, cancel } = options;
  const tab = await options.browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors: string[] = [];
  tab.on("pageerror", (error) => errors.push(error.message));
  // The exporter only ever talks to the developer's own machine.
  await tab.route("**/*", (route) => {
    const call = route.request();
    if (!call.isNavigationRequest()) return route.continue();
    const to = new URL(call.url());
    return to.protocol === "http:" && LOOPBACK.has(to.hostname) ? route.continue() : route.abort();
  });
  const file = await open(options.video, "w");
  try {
    await tab.exposeFunction("__FLICK_WRITE__", async (base64: string, position: number) => {
      const bytes = Buffer.from(base64, "base64");
      await file.write(bytes, 0, bytes.length, position);
    });
    await tab.exposeFunction("__FLICK_PROGRESS__", (done: number, total: number) => options.onProgress?.(done, total));
    try {
      await tab.goto(options.editorUrl, { waitUntil: "load", timeout: 30_000 });
    } catch {
      throw new Fault(
        "server-unreachable",
        `Could not open ${options.studioUrl}. Start your dev server, or pass its address with --url.`,
      );
    }
    try {
      await tab.waitForFunction(
        () => (window as { __FLICK__?: { kind?: string } }).__FLICK__?.kind === "take",
        undefined,
        { timeout: 45_000 },
      );
    } catch {
      const shown = await tab.evaluate(
        () => document.querySelector("[data-flick-chrome]")?.shadowRoot?.querySelector(".issues")?.textContent ?? "",
      );
      const reason = shown || errors[0] || "Check that the app was connected with flick init.";
      throw new Fault("clip-not-ready", `The take did not open at ${options.studioUrl}. ${reason}`);
    }
    cancel.check();
    try {
      return await tab.evaluate(
        (job) => (window as unknown as { __FLICK__: { encode(job: unknown): Promise<Encoded> } }).__FLICK__.encode(job),
        { fps: request.fps, width: request.width, height: request.height },
      );
    } catch (error) {
      cancel.check();
      const reason = (error as Error).message.split("\n")[0]!.replace(/^page\.evaluate: (Error: )?/, "");
      throw new Fault("encoding-failed", `The browser could not render the take: ${reason}`);
    }
  } finally {
    await file.close().catch(() => {});
  }
}

/** The take's sound for FFmpeg: its voice track unless muted, and its generated music. */
async function takeSound(root: string, take: Take, request: TakeRequest, directory: string, durationMs: number) {
  const { edit, source } = take;
  const voice = source.audio && !edit.audio.muted ? source.audio : undefined;
  const events = parseEvents(
    (await readText(root, `${TAKES_DIR}/${take.id}/${source.events.file}`)) ?? "",
    TakeEventSchema,
  );
  const music =
    request.music && edit.music
      ? await writeMusic(directory, edit.music, {
          key: `take:${take.id}`,
          durationMs,
          momentsMs: takeMoments(edit.trim, events),
        })
      : undefined;
  const audio = voice && {
    file: await resolveInside(root, `${TAKES_DIR}/${take.id}/${voice.file}`),
    startMs: edit.trim.startMs - voice.offsetMs,
    gain: edit.audio.gain,
    normalize: edit.audio.normalize,
  };
  return { audio, music };
}

export async function exportTake(input: unknown, context: ExportContext): Promise<Result<ExportTakeResult>> {
  const parsed = ExportTakeSchema.safeParse(input);
  if (!parsed.success) return fail(zodIssues(parsed.error, "invalid-export"));
  const request = parsed.data;
  const started = Date.now();
  const { root } = context;
  const cancel = cancellation(context.signal);
  let browser: Browser | undefined;
  let daemon: { port: number; token: string; close(): Promise<void> } | undefined;
  let directory: string | undefined;
  try {
    cancel.check();
    const take = await readTake(root, request.takeId);
    if (!take.ok) return take;
    const claim = await claimOutput(root, request.output, request.takeId);
    const studio = await resolveStudio({ url: request.url }, context);
    if (!studio.ok) return studio;
    directory = await workDirectory(claim);

    // The page reads the take and its media from a daemon; give it a private one for this export.
    daemon = await (await import("../daemon")).startDaemon({ root, port: 0, announce: false });
    const editor = new URL(studio.data.url);
    editor.searchParams.set(TAKE_PARAM, request.takeId);
    editor.hash = `${DAEMON_HASH}=${daemon.port}.${daemon.token}`;

    browser = await launchBrowser();
    cancel.onCancel(() => void browser?.close());
    const video = path.join(directory, "video.mp4");
    const encoded = await encodeInPage({
      browser,
      editorUrl: editor.toString(),
      studioUrl: studio.data.url,
      video,
      request,
      cancel,
      onProgress: context.onProgress,
    });
    cancel.check();

    const sound = await takeSound(root, take.data, request, directory, encoded.durationMs);
    const finished = path.join(directory, "finished.mp4");
    await finishTake({
      video,
      output: finished,
      cwd: root,
      durationMs: encoded.durationMs,
      copyVideo: encoded.codec === "avc",
      ...sound,
    });
    cancel.check();
    await publish(finished, claim);
    return ok({
      output: claim.output,
      fps: request.fps,
      frames: encoded.frames,
      durationMs: encoded.durationMs,
      width: encoded.width,
      height: encoded.height,
      codec: encoded.codec,
      audio: !!sound.audio || !!sound.music,
      elapsedMs: Date.now() - started,
    });
  } catch (error) {
    return fail(cancel.cancelled() ? [CANCELLED] : toIssues(error, "export-failed"));
  } finally {
    cancel.release();
    await browser?.close().catch(() => {});
    await daemon?.close().catch(() => {});
    await removeDirectory(directory);
  }
}
