import { CanvasSource, getFirstEncodableVideoCodec, Mp4OutputFormat, Output, StreamTarget } from "mediabunny";
import {
  buildTimeMap,
  type Caption,
  type CursorPath,
  captionAt,
  type KeyPill,
  keyPills,
  pillsAt,
  prepareCursor,
  type RedactionTrack,
  redactionTrack,
  resolveCaptions,
  resolveZoomTracks,
  type Span,
  type Take,
  type TakeEvent,
  type TimeMap,
  type ZoomTrack,
  zoomAt,
} from "../core";
import { type Context2D, drawTake } from "./draw";
import { type FrameSource, openFrameSource } from "./frames";

/** Renders a take to a canvas at any clip time, and encodes it to a video file.
 * Clip time runs from 0 at the trim start, through the take's time map (trim and pacing).
 * Preview and export call the same `renderAt`.
 */
export type EncodeJob = { fps: number; width: number; height: number };
export type EncodeResult = { codec: string; frames: number; width: number; height: number; durationMs: number };
export type TakeRenderer = {
  readonly durationMs: number;
  /** Clip time to take time, after trim and pacing. */
  readonly timeMap: TimeMap;
  readonly zoomTracks: readonly ZoomTrack[];
  /** Apply an edited take. Media is kept; zoom, cursor, redaction, captions and layout are derived again. */
  update(take: Take): void;
  /** Draw the frame at a clip time onto the preview canvas. Later calls supersede earlier ones. */
  renderAt(clipMs: number): Promise<void>;
  /** Render every frame and encode it. `write` receives file bytes and where they go. */
  encode(
    job: EncodeJob,
    write: (data: Uint8Array, position: number) => Promise<void> | void,
    progress?: (done: number, total: number) => void,
  ): Promise<EncodeResult>;
  close(): void;
};

const FADE_MS = 300;

export async function createTakeRenderer(options: {
  take: Take;
  events: readonly TakeEvent[];
  fileUrl: (name: string) => string;
  canvas: HTMLCanvasElement;
  /** Where the voice track has speech, on the take clock; pacing never speeds it up. */
  speech?: readonly Span[];
}): Promise<TakeRenderer> {
  const { events, canvas } = options;
  let take = options.take;
  const screen = await openFrameSource(options.fileUrl(take.source.screen.file));
  const cam: FrameSource | undefined = take.source.cam
    ? await openFrameSource(options.fileUrl(take.source.cam.file)).catch(() => undefined)
    : undefined;
  let zoomTracks: ZoomTrack[] = [];
  let cursor: CursorPath = prepareCursor(events, take.edit.cursor.smoothing);
  let smoothing = Number.NaN;
  let redaction: RedactionTrack = redactionTrack([], []);
  let captions: Caption[] = [];
  const pills: KeyPill[] = keyPills(events);
  let timeMap: TimeMap = buildTimeMap(take.edit, events, options.speech);
  const derive = () => {
    timeMap = buildTimeMap(take.edit, events, options.speech);
    zoomTracks = resolveZoomTracks(take.edit, events, take.source);
    redaction = redactionTrack(events, take.edit.redact);
    captions = resolveCaptions(take.edit, events);
    if (smoothing !== take.edit.cursor.smoothing) {
      smoothing = take.edit.cursor.smoothing;
      cursor = prepareCursor(events, smoothing);
    }
    if (canvas.width !== take.edit.canvas.width) canvas.width = take.edit.canvas.width;
    if (canvas.height !== take.edit.canvas.height) canvas.height = take.edit.canvas.height;
  };
  derive();

  /** One frame, fully drawn, on any 2D context of any size. */
  async function draw(ctx: Context2D, width: number, height: number, clipMs: number) {
    const timeMs = timeMap.toTake(clipMs);
    const [screenFrame, camFrame] = await Promise.all([
      screen.frameAt((timeMs - take.source.screen.offsetMs) / 1000),
      cam && take.source.cam && take.edit.cam.visible ? cam.frameAt((timeMs - take.source.cam.offsetMs) / 1000) : null,
    ]);
    const state = cursor.at(timeMs);
    const idle = take.edit.cursor.hideWhenIdleMs;
    const idleFor = timeMs - cursor.lastMoveBefore(timeMs);
    const opacity = idle === undefined ? 1 : Math.max(0, Math.min(1, 1 - (idleFor - idle) / FADE_MS));
    drawTake(ctx, width, height, take, {
      screen: screenFrame,
      cam: camFrame,
      view: zoomAt(zoomTracks, timeMs, take.source),
      cursor: { ...state, opacity },
      clicks: cursor.clicks.map((click) => ({ x: click.x, y: click.y, ageMs: timeMs - click.t })),
      redact: redaction.empty ? [] : redaction.at(timeMs),
      caption: captionAt(captions, timeMs),
      keys: pillsAt(pills, timeMs),
    });
  }

  const context = canvas.getContext("2d")!;
  let wanted: number | undefined;
  let running: Promise<void> | undefined;
  let closed = false;

  return {
    get durationMs() {
      return timeMap.durationMs;
    },
    get timeMap() {
      return timeMap;
    },
    get zoomTracks() {
      return zoomTracks;
    },
    update(next) {
      take = next;
      derive();
    },
    renderAt(clipMs) {
      wanted = clipMs;
      // Decoding is asynchronous; while one frame is in flight only the newest request is kept.
      running ??= (async () => {
        try {
          while (wanted !== undefined && !closed) {
            const time = wanted;
            wanted = undefined;
            await draw(context, canvas.width, canvas.height, time);
          }
        } finally {
          running = undefined;
        }
      })();
      return running;
    },
    async encode(job, write, progress) {
      await running;
      const surface = new OffscreenCanvas(job.width, job.height);
      const ctx = surface.getContext("2d")!;
      const bitrate = Math.round(Math.min(40e6, Math.max(2e6, job.width * job.height * job.fps * 0.1)));
      const codec = await getFirstEncodableVideoCodec(["avc", "vp9", "av1"], {
        width: job.width,
        height: job.height,
        bitrate,
      });
      if (!codec) throw new Error("This browser cannot encode video at the requested size.");
      const output = new Output({
        format: new Mp4OutputFormat({ fastStart: false }),
        target: new StreamTarget(
          new WritableStream({ write: (chunk) => write(chunk.data, chunk.position) as Promise<void> | undefined }),
        ),
      });
      const video = new CanvasSource(surface, { codec, bitrate, keyFrameInterval: 2 });
      output.addVideoTrack(video, { frameRate: job.fps });
      await output.start();
      const { durationMs } = timeMap;
      const frames = Math.max(1, Math.ceil((durationMs * job.fps) / 1000));
      for (let index = 0; index < frames; index++) {
        await draw(ctx, job.width, job.height, (index * 1000) / job.fps);
        await video.add(index / job.fps, 1 / job.fps);
        progress?.(index + 1, frames);
      }
      await output.finalize();
      return { codec, frames, width: job.width, height: job.height, durationMs: (frames * 1000) / job.fps };
    },
    close() {
      closed = true;
      screen.close();
      cam?.close();
    },
  };
}
