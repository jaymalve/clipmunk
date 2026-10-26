import { z } from "zod";
import { KeyframeSchema } from "./motion";
import { MusicSchema } from "./music";
import { ClipIdSchema } from "./recipe";
import { fail, type Issue, ok, type Result, zodIssues } from "./result";

/** A take is one recording session: screen video, optional camera and microphone,
 * and a log of what the pointer and keyboard did. `take.json` holds the recording and is
 * written once at ingest; `edit.json` beside it holds everything a person or agent changes.
 */
export const TAKES_DIR = ".clipmunk/takes";
export const TAKE_FILE = "take.json";
export const EDIT_FILE = "edit.json";
export const TAKE_PARAM = "clipmunk-take";
export const TAKE_TRACKS = ["screen", "cam", "mic", "events"] as const;
export type TakeTrack = (typeof TAKE_TRACKS)[number];

const finite = z.number().finite();
const ms = finite.nonnegative();
const rect = z.tuple([finite, finite, finite, finite]); // x, y, width, height in CSS pixels

/** Which element an interaction touched. `sel` is a CSS selector that matched only this
 * element when it was logged. `name` is its accessible name (a button's label, a field's
 * label), present only for controls, and never for an element inside a redaction selector.
 */
export const ElementSchema = z.strictObject({
  sel: z.string().min(1).max(300),
  role: z.string().max(40).optional(),
  name: z.string().max(80).optional(),
  testId: z.string().max(120).optional(),
});
export type ElementIdentity = z.output<typeof ElementSchema>;

/** One line of events.jsonl. `t` is milliseconds on the take clock; coordinates are CSS
 * pixels in the captured viewport. Typed text is never recorded: `type` only says that a
 * keystroke happened in an element, and `combo` names keys only when a modifier other than
 * Shift is held. `el` and the `route`, `combo` and `redact` kinds are absent from takes
 * recorded before they existed.
 */
export const TakeEventSchema = z.discriminatedUnion("k", [
  z.strictObject({ t: ms, k: z.literal("move"), x: finite, y: finite }),
  z.strictObject({
    t: ms,
    k: z.literal("down"),
    x: finite,
    y: finite,
    button: z.number().int(),
    rect,
    el: ElementSchema.optional(),
  }),
  z.strictObject({ t: ms, k: z.literal("up"), x: finite, y: finite, button: z.number().int() }),
  z.strictObject({ t: ms, k: z.literal("cursor"), style: z.enum(["default", "pointer", "text"]) }),
  z.strictObject({ t: ms, k: z.literal("scroll"), x: finite, y: finite }),
  z.strictObject({ t: ms, k: z.literal("focus"), rect, editable: z.boolean(), el: ElementSchema.optional() }),
  z.strictObject({ t: ms, k: z.literal("type"), rect }),
  z.strictObject({ t: ms, k: z.literal("resize"), width: finite.positive(), height: finite.positive() }),
  /** The page's path (no query or fragment, which can carry secrets), at the start and on every change. */
  z.strictObject({ t: ms, k: z.literal("route"), path: z.string().startsWith("/").max(2000) }),
  /** A key pressed with Meta, Control or Alt held, such as ["Meta", "K"]. */
  z.strictObject({ t: ms, k: z.literal("combo"), keys: z.array(z.string().min(1).max(20)).min(2).max(5) }),
  /** The boxes of every element matching one redaction selector, when they change. */
  z.strictObject({ t: ms, k: z.literal("redact"), sel: z.string().min(1).max(200), rects: z.array(rect).max(200) }),
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
  screen: z.strictObject({
    file: z.string(),
    offsetMs: finite,
    latencyMs: ms,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  cam: z
    .strictObject({
      file: z.string(),
      offsetMs: finite,
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      hasAudio: z.boolean(),
    })
    .optional(),
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
        ctx.addIssue({
          code: "custom",
          path: ["keyframes", index, "value"],
          message: "Zoom scale must be between 1 and 8.",
        });
      const previous = track.keyframes[index - 1];
      if (previous && frame.timeMs <= previous.timeMs)
        ctx.addIssue({
          code: "custom",
          path: ["keyframes", index, "timeMs"],
          message: "Keyframe times must be strictly increasing.",
        });
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

/** The sections of an edit. Presets carry partial copies of them (core/presets.ts). */
export const CanvasSchema = z.strictObject({
  width: z.number().int().min(64).max(3840).multipleOf(2).default(1920),
  height: z.number().int().min(64).max(3840).multipleOf(2).default(1080),
  background: z.string().default("#0b0b0f"),
  padding: finite.min(0).max(0.4).default(0.06),
  radius: finite.min(0).max(200).default(16),
  shadow: finite.min(0).max(1).default(0.5),
});
export const ZoomSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("auto"), params: AutoZoomParamsSchema.prefault({}) }),
  z.strictObject({ mode: z.literal("manual"), tracks: z.array(ZoomTrackSchema).max(3) }),
  z.strictObject({ mode: z.literal("off") }),
]);
export const CursorSchema = z.strictObject({
  visible: z.boolean().default(true),
  size: finite.min(0.5).max(4).default(1.4),
  smoothing: finite.min(0).max(1).default(0.6),
  clickEffect: z.enum(["ripple", "none"]).default("ripple"),
  hideWhenIdleMs: ms.optional(),
});
export const CamSchema = z.strictObject({
  visible: z.boolean().default(true),
  shape: z.enum(["circle", "rounded"]).default("circle"),
  corner: z.enum(["tl", "tr", "bl", "br"]).default("br"),
  size: finite.min(0.05).max(0.5).default(0.18),
  mirror: z.boolean().default(true),
});
export const AudioSchema = z.strictObject({
  muted: z.boolean().default(false),
  gain: finite.min(0).max(4).default(1),
  normalize: z.boolean().default(true),
});

/** How a hidden area is drawn: blurred, or covered with a solid block. */
export const RedactModeSchema = z.enum(["blur", "block"]);
export type RedactMode = z.output<typeof RedactModeSchema>;
/** Something to hide in every exported frame: the elements a redaction selector matched while
 * recording (their boxes come from the log's `redact` events), or a box in source CSS pixels
 * for a stretch of the take, for anything a selector does not cover.
 */
export const RedactEntrySchema = z.union([
  z.strictObject({ sel: z.string().min(1).max(200), mode: RedactModeSchema.default("blur") }),
  z
    .strictObject({
      rect,
      fromMs: ms,
      toMs: ms,
      mode: RedactModeSchema.default("blur"),
    })
    .refine((entry) => entry.toMs > entry.fromMs, { message: "A box must end after it starts.", path: ["toMs"] })
    .refine((entry) => entry.rect[2] > 0 && entry.rect[3] > 0, {
      message: "A box needs a width and a height.",
      path: ["rect"],
    }),
]);
export type RedactEntry = z.output<typeof RedactEntrySchema>;

/** A caption: text shown over the take from `atMs` for `durMs` (take clock). `auto` items come
 * from the generator (core/captions.ts); editing one makes it `manual`, and regeneration keeps
 * manual items. A manual item with empty text hides the automatic caption at its time.
 */
export const CaptionSchema = z.strictObject({
  atMs: ms,
  durMs: finite.positive().max(60_000),
  text: z.string().max(120),
  source: z.enum(["auto", "manual"]).default("manual"),
});
export type Caption = z.output<typeof CaptionSchema>;
export const CaptionsSchema = z.strictObject({
  /** Generate captions from the clicks in the log; otherwise only `items` are shown. */
  auto: z.boolean().default(true),
  items: z.array(CaptionSchema).max(500).default([]),
});
export const KeysSchema = z.strictObject({
  /** Show keyboard shortcuts (the log's `combo` events) as pills. Plain typing is never shown. */
  visible: z.boolean().default(true),
});

/** Pacing: idle gaps and runs of typing play faster (core/timemap.ts). Off unless a take turns it
 * on; ingest turns it on for new takes, so takes recorded before it play as they always did.
 */
export const PaceSchema = z.strictObject({
  deadAir: z
    .strictObject({
      on: z.boolean().default(false),
      /** A gap with no input and no speech longer than this plays fast, keeping this much at normal speed. */
      maxGapMs: finite.min(200).max(10_000).default(600),
      speed: finite.min(1).max(16).default(4),
    })
    .prefault({}),
  typing: z.strictObject({ on: z.boolean().default(false), speed: finite.min(1).max(8).default(2) }).prefault({}),
});
export type Pace = z.output<typeof PaceSchema>;

export const TakeEditSchema = z.strictObject({
  trim: z.strictObject({ startMs: ms, endMs: ms }),
  canvas: CanvasSchema.prefault({}),
  zoom: ZoomSchema.prefault({ mode: "auto" }),
  cursor: CursorSchema.prefault({}),
  cam: CamSchema.prefault({}),
  audio: AudioSchema.prefault({}),
  /** What to hide. Selector entries are filled in from the config when the take is saved. */
  redact: z.array(RedactEntrySchema).max(200).default([]),
  captions: CaptionsSchema.prefault({}),
  keys: KeysSchema.prefault({}),
  pace: PaceSchema.prefault({}),
  /** Background music generated by Clipmunk. */
  music: MusicSchema.optional(),
});
export type TakeEdit = z.output<typeof TakeEditSchema>;

const TitleSchema = z.string().trim().min(1);

/** `take.json`. Takes recorded before edits moved to `edit.json` still carry their edit here;
 * it is read until the first save writes `edit.json`, and never rewritten.
 */
export const TakeFileSchema = z.strictObject({
  version: z.literal(1),
  id: ClipIdSchema,
  title: TitleSchema,
  createdAt: z.iso.datetime(),
  source: TakeSourceSchema,
  edit: TakeEditSchema.optional(),
});
export type TakeFile = z.output<typeof TakeFileSchema>;

/** `edit.json`. A `title` here renames the take without touching `take.json`. */
export const TakeEditFileSchema = z.strictObject({
  version: z.literal(1),
  title: TitleSchema.optional(),
  edit: TakeEditSchema,
});
export type TakeEditFile = z.output<typeof TakeEditFileSchema>;

/** The merged view every renderer and exporter consumes. */
export const TakeSchema = z
  .strictObject({
    version: z.literal(1),
    id: ClipIdSchema,
    title: TitleSchema,
    createdAt: z.iso.datetime(),
    source: TakeSourceSchema,
    edit: TakeEditSchema,
  })
  .superRefine((take, ctx) => {
    if (take.edit.trim.endMs > take.source.durationMs + 1)
      ctx.addIssue({
        code: "custom",
        path: ["edit", "trim", "endMs"],
        message: "Trim end is past the end of the recording.",
      });
    if (take.edit.trim.startMs >= take.edit.trim.endMs && take.source.durationMs > 0)
      ctx.addIssue({ code: "custom", path: ["edit", "trim"], message: "Trim start must come before trim end." });
  });
export type Take = z.output<typeof TakeSchema>;

export function validateTake(input: unknown): Result<Take> {
  const parsed = TakeSchema.safeParse(input);
  return parsed.success ? ok(parsed.data) : fail(zodIssues(parsed.error, "invalid-take"));
}

/** The edit a new take starts with: untrimmed, a 16:9 canvas, auto-zoom on. */
export const defaultEdit = (durationMs: number): TakeEdit =>
  TakeEditSchema.parse({ trim: { startMs: 0, endMs: durationMs } });

/** Merge the two files of a take. The edit comes from `edit.json` when there is one, then from
 * an older `take.json` that still holds its edit, then from the defaults. Both inputs are
 * parsed JSON; issues name the file they belong to.
 */
export function composeTake(file: unknown, editFile?: unknown): Result<Take> {
  const take = TakeFileSchema.safeParse(file);
  if (!take.success) return fail(inFile(zodIssues(take.error, "invalid-take"), TAKE_FILE));
  const sidecar = editFile === undefined ? undefined : TakeEditFileSchema.safeParse(editFile);
  if (sidecar && !sidecar.success) return fail(inFile(zodIssues(sidecar.error, "invalid-take"), EDIT_FILE));
  const merged = TakeSchema.safeParse({
    ...take.data,
    title: sidecar?.data.title ?? take.data.title,
    edit: sidecar?.data.edit ?? take.data.edit ?? defaultEdit(take.data.source.durationMs),
  });
  if (!merged.success) return fail(inFile(zodIssues(merged.error, "invalid-take"), sidecar ? EDIT_FILE : TAKE_FILE));
  return ok(merged.data);
}
const inFile = (issues: Issue[], file: string) =>
  issues.map((issue) => ({ ...issue, path: issue.path ? `${file}: ${issue.path}` : file }));

/** The `edit.json` that stores `take`'s edit and title. The title is written only when it
 * differs from the recorded one, so an unrenamed take's edit file holds only its edit.
 */
export const editFileFor = (take: Take, recordedTitle: string): TakeEditFile => ({
  version: 1,
  ...(take.title !== recordedTitle ? { title: take.title } : {}),
  edit: take.edit,
});

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
export type TakeSummary = {
  id: string;
  title: string;
  createdAt: string;
  durationMs: number;
  width: number;
  height: number;
  hasCam: boolean;
  hasAudio: boolean;
};
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
export const DAEMON_FILE = ".clipmunk/daemon.json";
export const DAEMON_HASH = "clipmunk-daemon";
export const DEFAULT_DAEMON_PORT = 4747;
export const DaemonFileSchema = z.strictObject({
  port: z.number().int(),
  pid: z.number().int(),
  token: z.string().min(16),
  startedAt: z.string(),
});
export type DaemonFile = z.output<typeof DaemonFileSchema>;
