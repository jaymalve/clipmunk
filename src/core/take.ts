import { z } from "zod";
import { fail, ok, zodIssues, type Result } from "./result";
import { KeyframeSchema } from "./motion";
import { MusicSchema } from "./music";
import { ClipIdSchema } from "./recipe";

/** A take is one recording session: screen video, optional camera and microphone,
 * and a log of what the pointer and keyboard did. `source` is written once at ingest;
 * `edit` is everything a person or agent changes afterwards.
 */
export const TAKES_DIR = ".flick/takes";
export const TAKE_PARAM = "flick-take";
export const TAKE_TRACKS = ["screen", "cam", "mic", "events"] as const;
export type TakeTrack = (typeof TAKE_TRACKS)[number];

const finite = z.number().finite();
const ms = finite.nonnegative();
const rect = z.tuple([finite, finite, finite, finite]); // x, y, width, height in CSS pixels

/** One line of events.jsonl. `t` is milliseconds on the take clock; coordinates are CSS
 * pixels in the captured viewport. Typed text is never recorded: `type` only says that a
 * keystroke happened in an element.
 */
export const TakeEventSchema = z.discriminatedUnion("k", [
  z.strictObject({ t: ms, k: z.literal("move"), x: finite, y: finite }),
  z.strictObject({ t: ms, k: z.literal("down"), x: finite, y: finite, button: z.number().int(), rect }),
  z.strictObject({ t: ms, k: z.literal("up"), x: finite, y: finite, button: z.number().int() }),
  z.strictObject({ t: ms, k: z.literal("cursor"), style: z.enum(["default", "pointer", "text"]) }),
  z.strictObject({ t: ms, k: z.literal("scroll"), x: finite, y: finite }),
  z.strictObject({ t: ms, k: z.literal("focus"), rect, editable: z.boolean() }),
  z.strictObject({ t: ms, k: z.literal("type"), rect }),
  z.strictObject({ t: ms, k: z.literal("resize"), width: finite.positive(), height: finite.positive() }),
]);
export type TakeEvent = z.output<typeof TakeEventSchema>;

export const TakeSourceSchema = z.strictObject({
  /** Captured viewport in CSS pixels; video pixels are these times `dpr`. */
  width: finite.positive(),
  height: finite.positive(),
  dpr: finite.positive(),
  durationMs: ms,
  /** The page background, composited under the video where the capture is transparent. */
  background: z.string(),
  screen: z.strictObject({ file: z.string(), offsetMs: finite, latencyMs: ms, width: z.number().int().positive(), height: z.number().int().positive() }),
  cam: z.strictObject({ file: z.string(), offsetMs: finite, width: z.number().int().positive(), height: z.number().int().positive(), hasAudio: z.boolean() }).optional(),
  mic: z.strictObject({ file: z.string(), offsetMs: finite }).optional(),
  /** Extracted voice track, when the take has one. */
  audio: z.strictObject({ file: z.string(), offsetMs: finite }).optional(),
  events: z.strictObject({ file: z.string(), count: z.number().int().nonnegative() }),
});
export type TakeSource = z.output<typeof TakeSourceSchema>;

/** A keyframed zoom property: the centre of the view in source CSS pixels, or its magnification. */
export const ZoomTrackSchema = z
  .strictObject({
    target: z.strictObject({ kind: z.literal("zoom") }),
    property: z.enum(["x", "y", "scale"]),
    keyframes: z.array(KeyframeSchema).min(1),
  })
  .superRefine((track, ctx) => {
    track.keyframes.forEach((frame, index) => {
      if (track.property === "scale" && (frame.value < 1 || frame.value > 8))
        ctx.addIssue({ code: "custom", path: ["keyframes", index, "value"], message: "Zoom scale must be between 1 and 8." });
      const previous = track.keyframes[index - 1];
      if (previous && frame.timeMs <= previous.timeMs)
        ctx.addIssue({ code: "custom", path: ["keyframes", index, "timeMs"], message: "Keyframe times must be strictly increasing." });
    });
  });
export type ZoomTrack = z.output<typeof ZoomTrackSchema>;

export type AutoZoomParams = z.output<typeof AutoZoomParamsSchema>;
export const AutoZoomParamsSchema = z.strictObject({
  minScale: finite.min(1).max(4).default(1.25),
  maxScale: finite.min(1).max(6).default(2.2),
  mergeGapMs: ms.default(2500),
  leadMs: ms.default(300),
  holdMs: ms.default(1500),
  easeMs: finite.positive().default(700),
});

export const TakeEditSchema = z.strictObject({
  trim: z.strictObject({ startMs: ms, endMs: ms }),
  canvas: z.strictObject({
    width: z.number().int().min(64).max(3840).multipleOf(2).default(1920),
    height: z.number().int().min(64).max(3840).multipleOf(2).default(1080),
    background: z.string().default("#0b0b0f"),
    padding: finite.min(0).max(0.4).default(0.06),
    radius: finite.min(0).max(200).default(16),
    shadow: finite.min(0).max(1).default(0.5),
  }).prefault({}),
  zoom: z.discriminatedUnion("mode", [
    z.strictObject({ mode: z.literal("auto"), params: AutoZoomParamsSchema.prefault({}) }),
    z.strictObject({ mode: z.literal("manual"), tracks: z.array(ZoomTrackSchema).max(3) }),
    z.strictObject({ mode: z.literal("off") }),
  ]).prefault({ mode: "auto" }),
  cursor: z.strictObject({
    visible: z.boolean().default(true),
    size: finite.min(0.5).max(4).default(1.4),
    smoothing: finite.min(0).max(1).default(0.6),
    clickEffect: z.enum(["ripple", "none"]).default("ripple"),
    hideWhenIdleMs: ms.optional(),
  }).prefault({}),
  cam: z.strictObject({
    visible: z.boolean().default(true),
    shape: z.enum(["circle", "rounded"]).default("circle"),
    corner: z.enum(["tl", "tr", "bl", "br"]).default("br"),
    size: finite.min(0.05).max(0.5).default(0.18),
    mirror: z.boolean().default(true),
  }).prefault({}),
  audio: z.strictObject({ muted: z.boolean().default(false), gain: finite.min(0).max(4).default(1), normalize: z.boolean().default(true) }).prefault({}),
  /** Background music generated by Flick. */
  music: MusicSchema.optional(),
});
export type TakeEdit = z.output<typeof TakeEditSchema>;

export const TakeSchema = z
  .strictObject({
    version: z.literal(1),
    id: ClipIdSchema,
    title: z.string().trim().min(1),
    createdAt: z.iso.datetime(),
    source: TakeSourceSchema,
    edit: TakeEditSchema,
  })
  .superRefine((take, ctx) => {
    if (take.edit.trim.endMs > take.source.durationMs + 1) ctx.addIssue({ code: "custom", path: ["edit", "trim", "endMs"], message: "Trim end is past the end of the recording." });
    if (take.edit.trim.startMs >= take.edit.trim.endMs && take.source.durationMs > 0) ctx.addIssue({ code: "custom", path: ["edit", "trim"], message: "Trim start must come before trim end." });
  });
export type Take = z.output<typeof TakeSchema>;

export function validateTake(input: unknown): Result<Take> {
  const parsed = TakeSchema.safeParse(input);
  return parsed.success ? ok(parsed.data) : fail(zodIssues(parsed.error, "invalid-take"));
}

/** The edit a new take starts with: untrimmed, a 16:9 canvas, auto-zoom on. */
export const defaultEdit = (durationMs: number): TakeEdit => TakeEditSchema.parse({ trim: { startMs: 0, endMs: durationMs } });

/** What the recorder tells the daemon when a recording starts and when it stops. */
export const CreateTakeSchema = z.strictObject({
  title: z.string().trim().min(1).max(120).optional(),
  width: finite.positive().max(16384),
  height: finite.positive().max(16384),
  dpr: finite.positive().max(8),
  background: z.string().max(200),
});
export const FinalizeTakeSchema = z.strictObject({
  durationMs: ms.max(4 * 3600_000),
  screen: z.strictObject({ latencyMs: ms.max(2000) }),
  cam: z.strictObject({ offsetMs: finite, hasAudio: z.boolean() }).optional(),
  mic: z.strictObject({ offsetMs: finite }).optional(),
});
export type CreateTakeInput = z.input<typeof CreateTakeSchema>;
export type FinalizeTakeInput = z.input<typeof FinalizeTakeSchema>;

/** A take id that sorts by time and reads as a date: take-20261005-142233. */
export function takeId(now: Date): string {
  const p = (value: number) => String(value).padStart(2, "0");
  return `take-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

/** Summary rows for listings; the full take is fetched by id. */
export type TakeSummary = { id: string; title: string; createdAt: string; durationMs: number; width: number; height: number; hasCam: boolean; hasAudio: boolean };
export const summarizeTake = (take: Take): TakeSummary => ({
  id: take.id,
  title: take.title,
  createdAt: take.createdAt,
  durationMs: take.source.durationMs,
  width: take.source.screen.width,
  height: take.source.screen.height,
  hasCam: !!take.source.cam,
  hasAudio: !!take.source.audio,
});

/** The daemon's address and token, handed to the browser in a URL fragment. */
export const DAEMON_FILE = ".flick/daemon.json";
export const DAEMON_HASH = "flick-daemon";
export const DEFAULT_DAEMON_PORT = 4747;
export const DaemonFileSchema = z.strictObject({ port: z.number().int(), pid: z.number().int(), token: z.string().min(16), startedAt: z.string() });
export type DaemonFile = z.output<typeof DaemonFileSchema>;
