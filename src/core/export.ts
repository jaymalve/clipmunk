import { z } from "zod";
import { LoopbackOriginSchema } from "./project";
import { RATIOS, type Ratio } from "./ratio";
import { ClipIdSchema } from "./recipe";

/** Requests for local rendering. Validated here, executed by the export module. */
export const EXPORT_FPS = [30, 60, 120] as const;

const dimension = z.number().int().min(64).max(3840).multipleOf(2);
/** A project-relative path with no traversal; outputs never leave the project. */
const relativeFile = (extension: string) =>
  z
    .string()
    .min(1)
    .endsWith(extension)
    .refine(
      (value) =>
        !value.includes("\\") &&
        !value.includes("\0") &&
        !/^[A-Za-z]:/.test(value) &&
        value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
      `Use a project-relative ${extension} path without "..".`,
    );

export const ExportSceneSchema = z.strictObject({
  sceneId: ClipIdSchema,
  url: LoopbackOriginSchema,
  output: relativeFile(".mp4").optional(),
  fps: z.union(EXPORT_FPS.map((fps) => z.literal(fps))).default(60),
  /** Defaults to the scene's authored frame. */
  width: dimension.optional(),
  height: dimension.optional(),
  /** JPEG frames instead of PNG: faster, slightly lossy. */
  draft: z.boolean().default(false),
  workers: z.number().int().min(1).max(8).optional(),
  /** Include the scene's generated music. A sequence with its own music turns this off for its clips. */
  music: z.boolean().default(true),
  /** Include the scene's generated sound effects. A sequence lays them over the whole video itself. */
  sounds: z.boolean().default(true),
  /** The variant to render, as in the scene URL: "theme:dark,locale:de,ratio:9x16" (core/variants.ts). */
  variant: z
    .string()
    .max(200)
    .regex(/^[A-Za-z0-9:,_-]*$/, "Use a variant such as theme:dark,locale:de,ratio:9x16.")
    .optional(),
});
export type ExportSceneInput = z.input<typeof ExportSceneSchema>;
export type ExportSceneResult = {
  output: string;
  fps: number;
  frames: number;
  durationMs: number;
  width: number;
  height: number;
  workers: number;
  audio: boolean;
  elapsedMs: number;
  warnings?: string[];
};

export const SnapshotSceneSchema = z.strictObject({
  sceneId: ClipIdSchema,
  url: LoopbackOriginSchema,
  timeMs: z.number().finite().nonnegative().optional(),
});
export type SnapshotSceneResult = { sceneId: string; source: string; timeMs: number; bytes: number };

export const SNAPSHOT_WIDTH = 320;
export const MAX_EXPORT_DURATION_MS = 600_000;

export const ExportTakeSchema = z.strictObject({
  takeId: ClipIdSchema,
  /** Accepted for older callers and ignored: a take renders in the daemon's own Studio. */
  url: LoopbackOriginSchema.optional(),
  output: relativeFile(".mp4").optional(),
  fps: z.union([z.literal(30), z.literal(60)]).default(60),
  /** Defaults to the canvas size in the take's edit. Give one and the other follows the canvas shape. */
  width: dimension.optional(),
  height: dimension.optional(),
  /** Include the take's generated music. */
  music: z.boolean().default(true),
  /** Render reframed to this shape instead of the take's own (core/reframe.ts). */
  ratio: z.enum(RATIOS).optional(),
});
export type ExportTakeResult = {
  output: string;
  fps: number;
  frames: number;
  durationMs: number;
  width: number;
  height: number;
  codec: string;
  audio: boolean;
  elapsedMs: number;
};

export const ExportSequenceSchema = z.strictObject({
  sequenceId: ClipIdSchema,
  url: LoopbackOriginSchema,
  output: relativeFile(".mp4").optional(),
});
export type ExportSequenceResult = {
  output: string;
  fps: number;
  durationMs: number;
  width: number;
  height: number;
  items: number;
  audio: boolean;
  elapsedMs: number;
};

/** One export job with several outputs: every format in every ratio (and, for scenes, every
 * variant), named `<clip>[.<ratio>][.<variant>].<ext>` in `.clipmunk/exports/`, never
 * overwriting. The MP4 of each combination is rendered once; GIF and poster are made from it.
 */
export const EXPORT_FORMATS = ["mp4", "gif", "poster"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
export const GIF_MAX_BYTES = 5 * 1024 * 1024;
export const ExportJobSchema = z.strictObject({
  clip: z.strictObject({ kind: z.enum(["scene", "take", "sequence"]), id: ClipIdSchema }),
  /** The host's dev server, for scenes; the project's own when left out. Takes do not need it. */
  url: LoopbackOriginSchema.optional(),
  formats: z.array(z.enum(EXPORT_FORMATS)).min(1).max(3).optional(),
  ratios: z.array(z.enum(RATIOS)).min(1).max(4).optional(),
  variants: z.array(z.string().min(1).max(60)).min(1).max(32).optional(),
  /** "1920x1080"; the shape follows the clip (or the ratio), so only the short side is used then. */
  size: z
    .string()
    .regex(/^\d{2,4}x\d{2,4}$/, "Use a size such as 1920x1080.")
    .optional(),
  fps: z.union([z.literal(30), z.literal(60)]).optional(),
  /** A preset whose export options fill in what this job leaves out. */
  preset: ClipIdSchema.optional(),
  /** The poster's time in clip milliseconds; by default the first click or key moment. */
  posterAtMs: z.number().finite().nonnegative().optional(),
  /** The GIF size limit; frame rate, then size, step down until it fits. */
  gifMaxBytes: z
    .number()
    .int()
    .min(10_000)
    .max(100 * 1024 * 1024)
    .default(GIF_MAX_BYTES),
});
export type ExportJobInput = z.input<typeof ExportJobSchema>;
export type ExportOutput = {
  output: string;
  format: ExportFormat;
  ratio?: Ratio;
  variant?: string;
  width: number;
  height: number;
  /** MP4 and GIF. */
  durationMs?: number;
  fps?: number;
  /** Poster. */
  atMs?: number;
  bytes: number;
  /** What a GIF settled on to fit its size limit. */
  note?: string;
};
export type ExportJobResult = { outputs: ExportOutput[]; elapsedMs: number };

/** A ratio as it appears in a file name: 9:16 becomes 9x16. */
export const ratioToken = (ratio: Ratio) => ratio.replace(":", "x");
