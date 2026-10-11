import type { Result, Take, TakeTrack } from "../core";
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
const MARKER_KEY = "flick:recording";
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
  shim.setAttribute("data-flick-recorder", "backdrop");
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
  hideCursor.setAttribute("data-flick-recorder", "cursor");
  hideCursor.textContent = "body, body * { cursor: none !important; }";
  return {
    background,
    hideCursor: () => document.head.append(hideCursor),
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

export function createRecorder(client: DaemonClient, ignore: (event: Event) => boolean) {
  let state: RecorderState = { phase: "idle" };
  const listeners = new Set<(state: RecorderState) => void>();
  const set = (next: RecorderState) => {
    state = next;
    for (const listener of [...listeners]) listener(next);
  };
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
    set({ phase: "starting", step: "Checking the daemon…" });
    // Saving needs FFmpeg on the daemon's side. Find out before recording, not after.
    const status = await client.get<DaemonStatus>("/v1/status");
    if (!status.ok) return set({ phase: "error", message: status.issues[0]!.message });
    if (!status.data.ffmpeg)
      return set({
        phase: "error",
        message:
          "The Flick daemon cannot find FFmpeg, which it needs to save a recording. Install FFmpeg, or run `npm install -D ffmpeg-static` in your project, then restart `npx flick dev`.",
      });
    const streams: MediaStream[] = [];
    let page: ReturnType<typeof preparePage> | undefined;
    const cleanup = () => {
      for (const stream of streams) for (const track of stream.getTracks()) track.stop();
      page?.restore();
    };
    try {
      // Ask for the camera and microphone first, while the cursor is still visible.
      let voice: MediaStream | undefined;
      if (options.camera || options.microphone) {
        set({ phase: "starting", step: "Allow the camera or microphone…" });
        voice = await navigator.mediaDevices.getUserMedia({
          video: options.camera ? { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } : false,
          audio: options.microphone ? { echoCancellation: true, noiseSuppression: true } : false,
        });
        streams.push(voice);
      }
      set({ phase: "starting", step: "Choose this tab to share…" });
      const display = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 60 },
        audio: false,
        preferCurrentTab: true,
        selfBrowserSurface: "include",
      } as DisplayMediaStreamOptions);
      streams.push(display);
      const screenTrack = display.getVideoTracks()[0] as RestrictableTrack;
      if (screenTrack.getSettings().displaySurface !== "browser")
        throw new Error("Choose “This tab” in the sharing dialog. Flick records the app's own tab.");
      set({ phase: "starting", step: "Preparing the capture…" });
      page = preparePage();
      // Chrome leaves this pending forever if it cannot restrict the capture; never leave the recorder stuck on it.
      await within(
        8000,
        "Chrome did not restrict the capture to this page. Reload the page and try again.",
        (async () => screenTrack.restrictTo(await RestrictionTarget!.fromElement(document.body)))(),
      );
      const latencyMs = await measureLatency(display);

      const created = await client.post<{ id: string }>("/v1/takes", {
        width: innerWidth,
        height: innerHeight,
        dpr: devicePixelRatio,
        background: page.background,
      });
      if (!created.ok) throw new Error(created.issues[0]!.message);
      const takeId = created.data.id;
      const note = (text: string) => client.note(`/v1/takes/${takeId}/log`, text);
      note(
        `start ${innerWidth}x${innerHeight}@${devicePixelRatio} latency=${latencyMs}ms camera=${options.camera} microphone=${options.microphone} url=${location.pathname}${location.search} ua=${navigator.userAgent}`,
      );

      // Each track uploads its chunks strictly in order; a failed chunk is retried before the next is sent.
      let uploadError: string | undefined;
      const queues = new Map<TakeTrack, { seq: number; tail: Promise<void> }>();
      const upload = (track: TakeTrack, data: Blob) => {
        if (!data.size) return;
        const queue = queues.get(track) ?? { seq: 0, tail: Promise.resolve() };
        queues.set(track, queue);
        const seq = queue.seq++;
        queue.tail = queue.tail.then(async () => {
          for (let attempt = 0; attempt < 4 && !uploadError; attempt++) {
            const result: Result<unknown> = await client.put(`/v1/takes/${takeId}/media/${track}?seq=${seq}`, data);
            if (result.ok) return;
            if (result.issues[0]!.code !== "daemon-unreachable" || attempt === 3) {
              uploadError = result.issues[0]!.message;
              note(`upload failed ${track}#${seq}: ${uploadError}`);
              // Recording on with nowhere to put it would only lose more; stop now and say why.
              void stopActive?.();
            } else await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
          }
        });
      };
      const record = (track: TakeTrack, stream: MediaStream, mimeType: string | undefined, bitsPerSecond: number) => {
        const recorder = new MediaRecorder(stream, { mimeType, bitsPerSecond });
        recorder.ondataavailable = (event) => upload(track, event.data);
        recorder.onerror = (event) => {
          note(`${track} recorder error: ${(event as ErrorEvent).error?.message ?? "unknown"}`);
          void stopActive?.();
        };
        const stopped = new Promise<void>((resolve) => (recorder.onstop = () => resolve()));
        // The file's clock starts when start() is called, at the first frame that follows. The
        // `start` event fires a few hundred milliseconds later (measured), so it is not used.
        const started = performance.now();
        recorder.start(1000);
        return { recorder, started, stopped };
      };

      page.hideCursor();
      page.pulse(800);
      const pixels = screenTrack.getSettings().width! * screenTrack.getSettings().height!;
      const screen = record(
        "screen",
        display,
        pick(SCREEN_TYPES),
        Math.round(Math.min(24e6, Math.max(6e6, pixels * 4))),
      );
      const hasCamera = !!voice?.getVideoTracks().length,
        hasVoice = !!voice?.getAudioTracks().length;
      const side = voice
        ? record(
            hasCamera ? "cam" : "mic",
            voice,
            pick(hasCamera ? ["video/webm;codecs=vp8,opus", "video/webm"] : ["audio/webm;codecs=opus", "audio/webm"]),
            hasCamera ? 2.5e6 : 128e3,
          )
        : undefined;
      const startedAt = screen.started; // zero of the take clock
      const sideOffset = side ? Math.round(side.started - startedAt) : 0;
      const log = createEventLog({
        clock: () => performance.now() - startedAt,
        flush: (lines) => upload("events", new Blob([lines])),
        cursorOf: page.cursorOf,
        ignore,
      });
      log.start();

      const payloadFor = (durationMs: number) => ({
        durationMs,
        screen: { latencyMs },
        ...(side && hasCamera ? { cam: { offsetMs: sideOffset, hasAudio: hasVoice } } : {}),
        ...(side && !hasCamera ? { mic: { offsetMs: sideOffset } } : {}),
      });
      // A full page load ends a tab capture. Keep enough in sessionStorage to save what was uploaded.
      const mark = () =>
        sessionStorage.setItem(
          MARKER_KEY,
          JSON.stringify({
            takeId,
            startedAt: Date.now() - (performance.now() - startedAt),
            aliveAt: Date.now(),
            payload: payloadFor(0),
          } satisfies Marker),
        );
      mark();
      const heartbeat = setInterval(mark, 1000);
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

      stopActive = async () => {
        stopActive = undefined;
        const durationMs = performance.now() - startedAt;
        note(`stop after ${Math.round(durationMs)}ms`);
        clearInterval(heartbeat);
        for (const [target, type, listener] of watch) target.removeEventListener(type, listener);
        set({ phase: "saving" });
        log.stop();
        for (const item of [screen, side]) if (item && item.recorder.state !== "inactive") item.recorder.stop();
        await Promise.all([screen.stopped, side?.stopped]);
        cleanup();
        await Promise.all([...queues.values()].map((queue) => queue.tail));
        const save = saver(takeId, payloadFor(durationMs));
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
      set({ phase: "recording", startedAt, takeId, camera: hasCamera ? voice : undefined });
    } catch (error) {
      cleanup();
      const denied = error instanceof DOMException && error.name === "NotAllowedError";
      set({
        phase: "error",
        message: denied
          ? "Recording was not allowed. Approve the sharing, camera and microphone prompts and try again."
          : error instanceof Error
            ? error.message
            : String(error),
      });
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
