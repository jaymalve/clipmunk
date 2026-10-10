import { link, mkdir, mkdtemp, open, rm } from "node:fs/promises";
import path from "node:path";
import { DAEMON_HASH, EXPORTS_DIR, ExportTakeSchema, TAKES_DIR, TAKE_PARAM, TakeSchema, fail, ok, zodIssues, type ExportTakeResult, type Result } from "../core";
import { Fault, exists, readText, resolveInside, resolveStudio, toIssues } from "../project";
import { launchBrowser } from "./browser";
import { finishTake } from "./ffmpeg";
import type { ExportContext } from "./operations";

/** Export a take. The studio's take editor is opened in a headless page and asked to
 * render and encode every frame itself, with the same renderer the preview uses, so the
 * file matches what the editor shows. FFmpeg then adds the voice track.
 */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
type Encoded = { codec: string; frames: number; width: number; height: number; durationMs: number };

export async function exportTake(input: unknown, context: ExportContext): Promise<Result<ExportTakeResult>> {
  const parsed = ExportTakeSchema.safeParse(input);
  if (!parsed.success) return fail(zodIssues(parsed.error, "invalid-export"));
  const request = parsed.data;
  const started = Date.now();
  const { root, signal } = context;
  let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
  let daemon: { port: number; token: string; close(): Promise<void> } | undefined;
  let temporary: string | undefined;
  const abort = () => void browser?.close();
  const check = () => {
    if (signal?.aborted) throw new Fault("export-cancelled", "Export cancelled. No file was written.");
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    check();
    const source = `${TAKES_DIR}/${request.takeId}/take.json`;
    const text = await readText(root, source);
    if (text === undefined) throw new Fault("unknown-take", `No take named "${request.takeId}". Run flick takes to list them.`);
    const take = TakeSchema.safeParse(JSON.parse(text));
    if (!take.success) return fail(zodIssues(take.error, "invalid-take").map((issue) => ({ ...issue, path: `${source}: ${issue.path}` })));
    const { edit, source: media } = take.data;
    if (request.output && (await exists(root, request.output)))
      throw new Fault("output-exists", `${request.output} already exists. Choose another --output; Flick never overwrites a file.`, request.output);
    const studio = await resolveStudio({ url: request.url }, context);
    if (!studio.ok) return studio;
    let output = request.output;
    for (let n = 1; !output; n++) {
      const candidate = `${EXPORTS_DIR}/${request.takeId}${n === 1 ? "" : `-${n}`}.mp4`;
      if (!(await exists(root, candidate))) output = candidate;
    }
    const target = await resolveInside(root, output);
    await mkdir(path.dirname(target), { recursive: true });
    temporary = await mkdtemp(path.join(path.dirname(target), ".flick-export-"));

    // The page reads the take and its media from a daemon; give it a private one for this export.
    daemon = await (await import("../daemon")).startDaemon({ root, port: 0, announce: false });
    const page = new URL(studio.data.url);
    page.searchParams.set(TAKE_PARAM, request.takeId);
    page.hash = `${DAEMON_HASH}=${daemon.port}.${daemon.token}`;

    browser = await launchBrowser();
    const tab = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors: string[] = [];
    tab.on("pageerror", (error) => errors.push(error.message));
    await tab.route("**/*", (route) => {
      const call = route.request();
      if (!call.isNavigationRequest()) return route.continue();
      const to = new URL(call.url());
      return to.protocol === "http:" && LOOPBACK.has(to.hostname) ? route.continue() : route.abort();
    });
    const video = path.join(temporary, "video.mp4");
    const file = await open(video, "w");
    try {
      await tab.exposeFunction("__FLICK_WRITE__", async (base64: string, position: number) => {
        const bytes = Buffer.from(base64, "base64");
        await file.write(bytes, 0, bytes.length, position);
      });
      await tab.exposeFunction("__FLICK_PROGRESS__", (done: number, total: number) => context.onProgress?.(done, total));
      try {
        await tab.goto(page.toString(), { waitUntil: "load", timeout: 30_000 });
      } catch {
        throw new Fault("server-unreachable", `Could not open ${studio.data.url}. Start your dev server, or pass its address with --url.`);
      }
      try {
        await tab.waitForFunction(() => (window as { __FLICK__?: { kind?: string; encode?: unknown } }).__FLICK__?.kind === "take", undefined, { timeout: 45_000 });
      } catch {
        const shown = await tab.evaluate(() => document.querySelector("[data-flick-chrome]")?.shadowRoot?.querySelector(".issues")?.textContent ?? "");
        throw new Fault("clip-not-ready", `The take did not open at ${studio.data.url}. ${shown || errors[0] || "Check that the app was connected with flick init."}`);
      }
      check();
      let encoded: Encoded;
      try {
        encoded = await tab.evaluate(
          (job) => (window as unknown as { __FLICK__: { encode(job: unknown): Promise<Encoded> } }).__FLICK__.encode(job),
          { fps: request.fps, width: request.width, height: request.height },
        );
      } catch (error) {
        check();
        throw new Fault("encoding-failed", `The browser could not render the take: ${(error as Error).message.split("\n")[0]!.replace(/^page\.evaluate: (Error: )?/, "")}`);
      }
      await file.close();
      check();
      const voice = media.audio && !edit.audio.muted ? media.audio : undefined;
      const finished = path.join(temporary, "finished.mp4");
      await finishTake({
        video,
        output: finished,
        cwd: root,
        durationMs: encoded.durationMs,
        copyVideo: encoded.codec === "avc",
        audio: voice && { file: await resolveInside(root, `${TAKES_DIR}/${request.takeId}/${voice.file}`), startMs: edit.trim.startMs - voice.offsetMs, gain: edit.audio.gain, normalize: edit.audio.normalize },
      });
      check();
      try {
        await link(finished, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Fault("output-exists", `${output} appeared during the export. Choose another --output.`, output);
        throw error;
      }
      return ok({ output, fps: request.fps, frames: encoded.frames, durationMs: encoded.durationMs, width: encoded.width, height: encoded.height, codec: encoded.codec, audio: !!voice, elapsedMs: Date.now() - started });
    } finally {
      await file.close().catch(() => {});
    }
  } catch (error) {
    if (signal?.aborted) return fail([{ code: "export-cancelled", message: "Export cancelled. No file was written." }]);
    return fail(toIssues(error, "export-failed"));
  } finally {
    signal?.removeEventListener("abort", abort);
    await browser?.close().catch(() => {});
    await daemon?.close().catch(() => {});
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}
