import { type Result, redactionOf, type Take, type TakeTrack } from "../core";
import type { DaemonClient, DaemonStatus } from "./daemon";
import { createEventLog } from "./events";

/** One recording session of the app's own tab.
 * The capture is restricted to <body>, so the HUD (mounted on <html>) is never in the
 * video. The native cursor is hidden with CSS while recording because Chrome draws it
 * into tab capture; the HUD shows a stand-in and the real path goes to the event log.
 */
export type RecorderOptions = { camera: boolean; microphone: boolean };
export type RecorderState =
  | { phase: "idle" }
  | { phase: "starting"; step: string }
  | { phase: "recording"; startedAt: number; takeId: string; camera?: MediaStream }
  | { phase: "saving" }
  | { phase: "saved"; take: Take }
  /** `retry` is present when the recording itself is safe with the daemon and only saving failed. */
  | { phase: "error"; message: string; retry?: () => Promise<void> };

declare const RestrictionTarget: { fromElement(element: Element): Promise<unknown> } | undefined;
type RestrictableTrack = MediaStreamTrack & { restrictTo(target: unknown): Promise<void> };

/** Survives a reload of the tab, so an interrupted recording can still be saved afterwards. */
const MARKER_KEY = "clipmunk:recording";
type Marker = { takeId: string; startedAt: number; aliveAt: number; payload: Record<string, unknown> };
const readMarker = (): Marker | undefined => {
  try {
    return JSON.parse(sessionStorage.getItem(MARKER_KEY) ?? "null") ?? undefined;
  } catch {
    return undefined;
  }
};
export const hasInterruptedRecording = () => !!readMarker();

const SCREEN_TYPES = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
const pick = (types: string[]) => types.find((type) => MediaRecorder.isTypeSupported(type));
const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
const within = <T>(ms: number, message: string, work: Promise<T>): Promise<T> =>
  Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), ms))]);
const transparent = (color: string) => color === "transparent" || /rgba\([^)]*,\s*0\)$/.test(color);

export function isSupported(): string | undefined {
  if (
    typeof RestrictionTarget === "undefined" ||
    !navigator.mediaDevices?.getDisplayMedia ||
    typeof MediaRecorder === "undefined"
  )
    return "Recording needs a recent Chromium-based browser (Chrome or Edge 132+).";
  return undefined;
}

/** Changes made to the page for the duration of a recording, with one function to undo them all. */
function preparePage() {
  const body = document.body;
  const html = getComputedStyle(document.documentElement),
    own = getComputedStyle(body);
  // A background on <html> or <body> paints on the canvas, outside the captured element.
  const source = !transparent(html.backgroundColor) || html.backgroundImage !== "none" ? html : own;
  const background = transparent(source.backgroundColor) ? "rgb(255, 255, 255)" : source.backgroundColor;
  const shim = document.createElement("div");
  shim.setAttribute("data-clipmunk-recorder", "backdrop");
  shim.style.cssText = `position:fixed;inset:0;z-index:-2147483647;pointer-events:none;background:${source.backgroundImage !== "none" ? source.background : background}`;
  const previousIsolation = body.style.isolation;
  body.style.isolation = "isolate"; // required for the element to be capturable, and scopes the shim's z-index
  body.prepend(shim);
  // One pixel that can be repainted on demand. A tab capture only emits a frame when the page
  // repaints, and the recording's clock starts at its first frame, so the recorder repaints
  // as recording starts. The first frame then shows the page at take time zero, and every later
  // frame keeps that alignment, whatever the capture delay is.
  const tick = document.createElement("div");
  tick.style.cssText = `position:absolute;right:0;bottom:0;width:1px;height:1px;background:${background}`;
  shim.append(tick);
  const hideCursor = document.createElement("style");
  hideCursor.setAttribute("data-clipmunk-recorder", "cursor");
  hideCursor.textContent = "body, body * { cursor: none !important; }";
  const mask = document.createElement("style");
  mask.setAttribute("data-clipmunk-recorder", "redact");
  return {
    background,
    hideCursor: () => document.head.append(hideCursor),
    /** Blur these elements in the page itself, so they never reach the screen video. One rule per
     * selector: a selector the browser cannot parse drops only its own rule.
     */
    mask(selectors: readonly string[]) {
      if (!selectors.length) return;
      mask.textContent = selectors.map((selector) => `${selector} { filter: blur(12px) !important; }`).join("\n");
      document.head.append(mask);
    },
    /** Repaint on every frame for `ms` milliseconds. */
    pulse(ms: number) {
      const until = performance.now() + ms;
      let flip = 0;
      const step = () => {
        flip ^= 1;
        tick.style.opacity = String(0.99 - flip * 0.01);
        if (performance.now() < until && tick.isConnected) requestAnimationFrame(step);
      };
      step();
    },
    /** The cursor an element asks for, read with our override switched off for an instant. */
    cursorOf(element: Element) {
      if (!hideCursor.sheet) return getComputedStyle(element).cursor;
      hideCursor.sheet.disabled = true;
      const cursor = getComputedStyle(element).cursor;
      hideCursor.sheet.disabled = false;
      return cursor;
    },
    restore() {
      shim.remove();
      hideCursor.remove();
      mask.remove();
      body.style.isolation = previousIsolation;
    },
  };
}

/** How long a paint takes to reach the captured stream, for the record. Flashes a marker between
 * two colours a few times and takes the median delay from paint to the frame's capture time.
 * Sync does not depend on this number (see `pulse` below); it is stored for diagnosis.
 */
async function measureLatency(stream: MediaStream): Promise<number> {
  const video = document.createElement("video");
  video.muted = true;
  video.srcObject = stream;
  const marker = document.createElement("div");
  marker.style.cssText = "position:fixed;left:0;top:0;width:32px;height:32px;z-index:2147483646;pointer-events:none";
  type FrameInfo = { now: number; captureTime?: number };
  const nextFrame = (ms: number) =>
    Promise.race([
      new Promise<FrameInfo | undefined>((resolve) =>
        video.requestVideoFrameCallback((now, metadata) =>
          resolve({ now, captureTime: (metadata as { captureTime?: number }).captureTime }),
        ),
      ),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms)),
    ]);
  try {
    // Not awaited: a tab capture produces no frame until the page repaints, so play() can stay
    // pending on a still page. Every colour change below is a repaint; deadlines bound each wait.
    void video.play().catch(() => {});
    const canvas = new OffscreenCanvas(8, 8);
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    const colours = [
      [255, 0, 255],
      [0, 255, 255],
    ] as const;
    const shows = (colour: readonly [number, number, number]) => {
      if (!video.videoWidth) return false;
      const scale = video.videoWidth / innerWidth;
      context.drawImage(video, 8 * scale, 8 * scale, 8 * scale, 8 * scale, 0, 0, 8, 8);
      const pixel = context.getImageData(4, 4, 1, 1).data;
      return colour.every((channel, index) => Math.abs(pixel[index]! - channel) < 70);
    };
    document.body.append(marker);
    const samples: number[] = [];
    // The first flash only warms the video element up; its delay includes start-up and is discarded.
    for (let flash = 0; flash < 5; flash++) {
      const colour = colours[flash % 2]!;
      marker.style.background = `rgb(${colour.join(",")})`;
      const painted = await frame();
      const deadline = performance.now() + 700;
      while (performance.now() < deadline) {
        const info = await nextFrame(250);
        if (info && shows(colour)) {
          if (flash > 0) samples.push((info.captureTime ?? info.now) - painted);
          break;
        }
      }
    }
    samples.sort((a, b) => a - b);
    return samples.length ? Math.max(0, Math.min(1000, Math.round(samples[samples.length >> 1]!))) : 0;
  } catch {
    return 0;
  } finally {
    marker.remove();
    video.srcObject = null;
    await frame();
    await frame(); // let the marker leave the stream before recording begins
  }
}

type Note = (text: string) => void;
type Page = ReturnType<typeof preparePage>;

/** The project's redaction settings. A config the daemon cannot read means none, noted in the take's log. */
async function redactionSettings(
  client: DaemonClient,
): Promise<{ selectors: string[]; live: boolean; problem?: string }> {
  const config = await client.get<{ config: Parameters<typeof redactionOf>[0] }>("/v1/config");
  if (config.ok) return redactionOf(config.data.config);
  return { selectors: [], live: false, problem: config.issues[0]?.message };
}

/** Saving needs the daemon and FFmpeg on its side. Find out before recording, not after. */
async function daemonProblem(client: DaemonClient): Promise<string | undefined> {
  const status = await client.get<DaemonStatus>("/v1/status");
  if (!status.ok) return status.issues[0]!.message;
  if (!status.data.ffmpeg)
    return "The Clipmunk daemon cannot find FFmpeg, which it needs to save a recording. Install FFmpeg, or run `npm install -D ffmpeg-static` in your project, then restart `npx clipmunk dev`.";
  return undefined;
}

/** Ask for the camera and microphone, then for the tab. Every stream is added to `streams`
 * as soon as it exists, so the caller can stop them all even if a later prompt is refused.
 */
async function openStreams(options: RecorderOptions, streams: MediaStream[], step: (text: string) => void) {
  // The camera and microphone come first, while the cursor is still visible.
  let voice: MediaStream | undefined;
  if (options.camera || options.microphone) {
    step("Allow the camera or microphone…");
    voice = await navigator.mediaDevices.getUserMedia({
      video: options.camera ? { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } : false,
      audio: options.microphone ? { echoCancellation: true, noiseSuppression: true } : false,
    });
    streams.push(voice);
  }
  step("Choose this tab to share…");
  const display = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: 60 },
    audio: false,
    preferCurrentTab: true,
    selfBrowserSurface: "include",
  } as DisplayMediaStreamOptions);
  streams.push(display);
  const screenTrack = display.getVideoTracks()[0] as RestrictableTrack;
  if (screenTrack.getSettings().displaySurface !== "browser")
    throw new Error("Choose “This tab” in the sharing dialog. Clipmunk records the app's own tab.");
  return { voice, display, screenTrack };
}

/** Create the take with the daemon and open its log with the conditions it was recorded under. */
async function openTake(client: DaemonClient, background: string, options: RecorderOptions, latencyMs: number) {
  const created = await client.post<{ id: string }>("/v1/takes", {
    width: innerWidth,
    height: innerHeight,
    dpr: devicePixelRatio,
    background,
  });
  if (!created.ok) throw new Error(created.issues[0]!.message);
  const takeId = created.data.id;
  const note: Note = (text) => client.note(`/v1/takes/${takeId}/log`, text);
  note(
    `start ${innerWidth}x${innerHeight}@${devicePixelRatio} latency=${latencyMs}ms camera=${options.camera} microphone=${options.microphone} url=${location.pathname}${location.search} ua=${navigator.userAgent}`,
  );
  return { takeId, note };
}

/** Sends a take's chunks to the daemon. Each track uploads strictly in order; a failed chunk
 * is retried before the next is sent. `onFailure` runs once a chunk is given up on.
 */
function createUploader(client: DaemonClient, takeId: string, note: Note, onFailure: () => void) {
  let error: string | undefined;
  const queues = new Map<TakeTrack, { seq: number; tail: Promise<void> }>();
  const send = async (track: TakeTrack, seq: number, data: Blob) => {
    for (let attempt = 0; attempt < 4 && !error; attempt++) {
      const result: Result<unknown> = await client.put(`/v1/takes/${takeId}/media/${track}?seq=${seq}`, data);
      if (result.ok) return;
      if (result.issues[0]!.code !== "daemon-unreachable" || attempt === 3) {
        error = result.issues[0]!.message;
        note(`upload failed ${track}#${seq}: ${error}`);
        onFailure();
      } else await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
  };
  return {
    upload(track: TakeTrack, data: Blob) {
      if (!data.size) return;
      const queue = queues.get(track) ?? { seq: 0, tail: Promise.resolve() };
      queues.set(track, queue);
      const seq = queue.seq++;
      queue.tail = queue.tail.then(() => send(track, seq, data));
    },
    /** Resolves when everything handed over so far has been sent or given up on. */
    settled: () => Promise.all([...queues.values()].map((queue) => queue.tail)),
    get error() {
      return error;
    },
  };
}

/** Start a MediaRecorder that hands over a chunk every second. */
function recordStream(
  stream: MediaStream,
  format: { mimeType: string | undefined; bitsPerSecond: number },
  onData: (data: Blob) => void,
  onError: (message: string) => void,
) {
  const recorder = new MediaRecorder(stream, format);
  recorder.ondataavailable = (event) => onData(event.data);
  recorder.onerror = (event) => onError((event as ErrorEvent).error?.message ?? "unknown");
  const stopped = new Promise<void>((resolve) => (recorder.onstop = () => resolve()));
  // The file's clock starts when start() is called, at the first frame that follows. The
  // `start` event fires a few hundred milliseconds later (measured), so it is not used.
  const started = performance.now();
  recorder.start(1000);
  return { recorder, started, stopped };
}

/** A full page load ends a tab capture. Keep enough in sessionStorage, refreshed every
 * second, to save what was uploaded. Returns the function that stops refreshing.
 */
function keepMarker(takeId: string, startedAt: number, payload: Record<string, unknown>): () => void {
  const mark = () => {
    const marker: Marker = {
      takeId,
      startedAt: Date.now() - (performance.now() - startedAt),
      aliveAt: Date.now(),
      payload,
    };
    sessionStorage.setItem(MARKER_KEY, JSON.stringify(marker));
  };
  mark();
  const heartbeat = setInterval(mark, 1000);
  return () => clearInterval(heartbeat);
}

/** Write what happens to the page during a recording into the take's log. Returns the undo. */
function watchPage(note: Note, screenTrack: MediaStreamTrack): () => void {
  // biome-ignore lint/suspicious/noExplicitAny: the list mixes error, rejection and lifecycle handlers
  const watch: [EventTarget, string, (event: any) => void][] = [
    [window, "pagehide", () => note("pagehide: the page is unloading (reload or navigation) while recording")],
    [window, "error", (event: ErrorEvent) => note(`window error: ${event.message}`)],
    [
      window,
      "unhandledrejection",
      (event: PromiseRejectionEvent) => note(`unhandled rejection: ${String(event.reason)}`),
    ],
    [document, "visibilitychange", () => note(`visibility ${document.visibilityState}`)],
    [screenTrack, "mute", () => note("screen track muted")],
  ];
  for (const [target, type, listener] of watch) target.addEventListener(type, listener);
  return () => {
    for (const [target, type, listener] of watch) target.removeEventListener(type, listener);
  };
}

type Capture = {
  client: DaemonClient;
  takeId: string;
  note: Note;
  page: Page;
  display: MediaStream;
  voice: MediaStream | undefined;
  latencyMs: number;
  ignore: (event: Event) => boolean;
  redact: string[];
  /** Something went wrong that recording on cannot fix; the recording should stop. */
  onFault: () => void;
};

/** Start recording every track of a take. From here until `finish`, the take is running. */
function beginCapture(capture: Capture) {
  const { takeId, note, page, display, voice, latencyMs } = capture;
  const uploader = createUploader(capture.client, takeId, note, capture.onFault);
  const record = (track: TakeTrack, stream: MediaStream, mimeType: string | undefined, bitsPerSecond: number) =>
    recordStream(
      stream,
      { mimeType, bitsPerSecond },
      (data) => uploader.upload(track, data),
      (message) => {
        note(`${track} recorder error: ${message}`);
        capture.onFault();
      },
    );

  page.hideCursor();
  page.pulse(800);
  const screenTrack = display.getVideoTracks()[0]!;
  const pixels = screenTrack.getSettings().width! * screenTrack.getSettings().height!;
  const screen = record("screen", display, pick(SCREEN_TYPES), Math.round(Math.min(24e6, Math.max(6e6, pixels * 4))));
  const hasCamera = !!voice?.getVideoTracks().length,
    hasVoice = !!voice?.getAudioTracks().length;
  const sideTypes = hasCamera ? ["video/webm;codecs=vp8,opus", "video/webm"] : ["audio/webm;codecs=opus", "audio/webm"];
  const side = voice ? record(hasCamera ? "cam" : "mic", voice, pick(sideTypes), hasCamera ? 2.5e6 : 128e3) : undefined;
  const startedAt = screen.started; // zero of the take clock
  const sideOffset = side ? Math.round(side.started - startedAt) : 0;
  const log = createEventLog({
    clock: () => performance.now() - startedAt,
    flush: (lines) => uploader.upload("events", new Blob([lines])),
    cursorOf: page.cursorOf,
    ignore: capture.ignore,
    redact: capture.redact,
    onIssue: note,
  });
  log.start();

  const payloadFor = (durationMs: number) => ({
    durationMs,
    screen: { latencyMs },
    ...(side && hasCamera ? { cam: { offsetMs: sideOffset, hasAudio: hasVoice } } : {}),
    ...(side && !hasCamera ? { mic: { offsetMs: sideOffset } } : {}),
  });
  const stopMarker = keepMarker(takeId, startedAt, payloadFor(0));
  const unwatch = watchPage(note, screenTrack);

  return {
    startedAt,
    camera: hasCamera ? voice : undefined,
    /** The take ends now: fix its length and stop watching the page. Returns what to finalise it with. */
    halt() {
      const durationMs = performance.now() - startedAt;
      note(`stop after ${Math.round(durationMs)}ms`);
      stopMarker();
      unwatch();
      return payloadFor(durationMs);
    },
    /** Stop the recorders, `release` the streams, and wait for the last chunks to reach the daemon.
     * Resolves with the upload failure, if there was one.
     */
    async finish(release: () => void): Promise<string | undefined> {
      log.stop();
      for (const item of [screen, side]) if (item && item.recorder.state !== "inactive") item.recorder.stop();
      await Promise.all([screen.stopped, side?.stopped]);
      release();
      await uploader.settled();
      return uploader.error;
    },
  };
}

function explain(error: unknown): string {
  if (error instanceof DOMException && error.name === "NotAllowedError")
    return "Recording was not allowed. Approve the sharing, camera and microphone prompts and try again.";
  return error instanceof Error ? error.message : String(error);
}

export function createRecorder(client: DaemonClient, ignore: (event: Event) => boolean) {
  let state: RecorderState = { phase: "idle" };
  const listeners = new Set<(state: RecorderState) => void>();
  const set = (next: RecorderState) => {
    state = next;
    for (const listener of [...listeners]) listener(next);
  };
  const step = (text: string) => set({ phase: "starting", step: text });
  let stopActive: (() => Promise<void>) | undefined;

  /** Finalise a take whose chunks are with the daemon. A failure keeps everything and can be retried. */
  const saver = (takeId: string, payload: Record<string, unknown>) => {
    const save = async (): Promise<void> => {
      set({ phase: "saving" });
      const saved = await client.post<Take>(`/v1/takes/${takeId}/finalize`, payload);
      if (saved.ok) sessionStorage.removeItem(MARKER_KEY);
      set(
        saved.ok
          ? { phase: "saved", take: saved.data }
          : { phase: "error", message: saved.issues[0]!.message, retry: save },
      );
    };
    return save;
  };

  async function start(options: RecorderOptions): Promise<void> {
    if (state.phase === "starting" || state.phase === "recording" || state.phase === "saving") return;
    const unsupported = isSupported();
    if (unsupported) return set({ phase: "error", message: unsupported });
    step("Checking the daemon…");
    const problem = await daemonProblem(client);
    if (problem) return set({ phase: "error", message: problem });
    const redact = await redactionSettings(client);
    const streams: MediaStream[] = [];
    let page: Page | undefined;
    const cleanup = () => {
      for (const stream of streams) for (const track of stream.getTracks()) track.stop();
      page?.restore();
    };
    try {
      const { voice, display, screenTrack } = await openStreams(options, streams, step);
      step("Preparing the capture…");
      page = preparePage();
      // Chrome leaves this pending forever if it cannot restrict the capture; never leave the recorder stuck on it.
      await within(
        8000,
        "Chrome did not restrict the capture to this page. Reload the page and try again.",
        (async () => screenTrack.restrictTo(await RestrictionTarget!.fromElement(document.body)))(),
      );
      const latencyMs = await measureLatency(display);
      const { takeId, note } = await openTake(client, page.background, options, latencyMs);
      if (redact.problem) note(`config not read, recording without redaction: ${redact.problem}`);
      if (redact.live) page.mask(redact.selectors);
      // Recording on with nowhere to put it would only lose more; a fault stops the take and says why.
      const onFault = () => void stopActive?.();
      const capture = beginCapture({
        client,
        takeId,
        note,
        page,
        display,
        voice,
        latencyMs,
        ignore,
        redact: redact.selectors,
        onFault,
      });
      stopActive = async () => {
        stopActive = undefined;
        const payload = capture.halt();
        set({ phase: "saving" });
        const uploadError = await capture.finish(cleanup);
        const save = saver(takeId, payload);
        // What reached the daemon before an upload failed is still a usable recording.
        if (uploadError)
          return set({
            phase: "error",
            message: `Recording stopped because uploading to the daemon failed: ${uploadError} You can save the part that was uploaded.`,
            retry: save,
          });
        await save();
      };
      // The browser's own "Stop sharing" button ends the recording the same way ours does.
      screenTrack.addEventListener("ended", () => {
        note("screen track ended (sharing was stopped from the browser)");
        void stopActive?.();
      });
      set({ phase: "recording", startedAt: capture.startedAt, takeId, camera: capture.camera });
    } catch (error) {
      cleanup();
      set({ phase: "error", message: explain(error) });
    }
  }

  return {
    get state() {
      return state;
    },
    subscribe(listener: (state: RecorderState) => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    start,
    stop: () => stopActive?.() ?? Promise.resolve(),
    /** Discards a pending retry and any interrupted-recording marker. */
    reset() {
      if (state.phase === "recording" || state.phase === "saving" || state.phase === "starting") return;
      sessionStorage.removeItem(MARKER_KEY);
      set({ phase: "idle" });
    },
    /** After a reload: if a recording was cut off, offer to save what the daemon already has. */
    recoverInterrupted() {
      const marker = readMarker();
      if (!marker || state.phase !== "idle") return;
      const seconds = Math.max(0, (marker.aliveAt - marker.startedAt) / 1000);
      client.note(`/v1/takes/${marker.takeId}/log`, "page loaded again after an interrupted recording");
      set({
        phase: "error",
        message: `The page reloaded or navigated during the last recording, which ends a tab capture. About ${seconds.toFixed(1)} s were captured.`,
        retry: saver(marker.takeId, { ...marker.payload, durationMs: marker.aliveAt - marker.startedAt }),
      });
    },
  };
}
export type Recorder = ReturnType<typeof createRecorder>;
