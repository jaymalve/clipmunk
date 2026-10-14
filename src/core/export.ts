import { z } from "zod";
import { LoopbackOriginSchema } from "./project";
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
  url: LoopbackOriginSchema,
  output: relativeFile(".mp4").optional(),
  fps: z.union([z.literal(30), z.literal(60)]).default(60),
  /** Defaults to the canvas size in the take's edit. Give one and the other follows the canvas shape. */
  width: dimension.optional(),
  height: dimension.optional(),
  /** Include the take's generated music. */
  music: z.boolean().default(true),
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
