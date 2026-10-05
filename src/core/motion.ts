import { z } from "zod";
import { fail, ok, zodIssues, type Result } from "./result";
import { CameraSchema, FocusSchema, TransformSchema } from "./scene";

/** Keyframed motion. Validate once with compileMotion, then evaluate any number of
 * frames with evaluateMotion; evaluation is a pure function of elapsed time.
 * Authored times are in authored milliseconds; `speed` maps them to presentation time.
 */
const finite = z.number().finite();
export const EASINGS = ["linear", "easeInOut", "cinematic"] as const;
export type Easing = (typeof EASINGS)[number];

export const KeyframeSchema = z.strictObject({
  timeMs: finite.nonnegative(),
  value: finite,
  // Applies to the segment that starts at this keyframe.
  easing: z.enum(EASINGS).default("cinematic"),
});
export type Keyframe = z.output<typeof KeyframeSchema>;
const keyframes = z.array(KeyframeSchema).min(1);

const SurfaceProps = TransformSchema.extend({ opacity: finite.min(0).max(1) });
const CameraProps = CameraSchema.omit({ perspective: true });
const FocusProps = FocusSchema;
const PROPS = { surface: SurfaceProps, camera: CameraProps, focus: FocusProps } as const;

export const SceneTrackSchema = z
  .union([
    z.strictObject({
      target: z.strictObject({ kind: z.literal("surface"), id: z.string().min(1) }),
      property: SurfaceProps.keyof(),
      keyframes,
    }),
    z.strictObject({ target: z.strictObject({ kind: z.literal("camera") }), property: CameraProps.keyof(), keyframes }),
    z.strictObject({ target: z.strictObject({ kind: z.literal("focus") }), property: FocusProps.keyof(), keyframes }),
  ])
  .superRefine((track, ctx) => {
    const bounds = PROPS[track.target.kind].partial();
    track.keyframes.forEach((frame, index) => {
      // Each value must satisfy the bounds of the property it animates.
      const value = bounds.safeParse({ [track.property]: frame.value });
      if (!value.success)
        for (const issue of value.error.issues)
          ctx.addIssue({ code: "custom", path: ["keyframes", index, "value"], message: issue.message });
      const previous = track.keyframes[index - 1];
      if (previous && frame.timeMs <= previous.timeMs)
        ctx.addIssue({ code: "custom", path: ["keyframes", index, "timeMs"], message: "Keyframe times must be strictly increasing." });
    });
  });
export type SceneTrack = z.output<typeof SceneTrackSchema>;

const trackKey = (track: SceneTrack) =>
  `${track.target.kind}:${track.target.kind === "surface" ? track.target.id : ""}:${track.property}`;

export const MotionSchema = z
  .strictObject({
    durationMs: finite.nonnegative().max(600_000),
    speed: finite.min(0.05).max(4).default(1),
    tracks: z.array(SceneTrackSchema).max(2000),
  })
  .superRefine((motion, ctx) => {
    const seen = new Set<string>();
    motion.tracks.forEach((track, index) => {
      const key = trackKey(track);
      if (seen.has(key)) ctx.addIssue({ code: "custom", path: ["tracks", index], message: "Duplicate track for the same target and property." });
      seen.add(key);
      track.keyframes.forEach((frame, frameIndex) => {
        if (frame.timeMs > motion.durationMs)
          ctx.addIssue({ code: "custom", path: ["tracks", index, "keyframes", frameIndex, "timeMs"], message: "Keyframe time exceeds the scene duration." });
      });
    });
  });
export type Motion = z.output<typeof MotionSchema>;
export type MotionInput = z.input<typeof MotionSchema>;

export type SurfaceOverride = Partial<z.output<typeof SurfaceProps>>;
export type MotionState = {
  surfaces: ReadonlyMap<string, SurfaceOverride>;
  camera: Partial<z.output<typeof CameraProps>>;
  focus: Partial<z.output<typeof FocusProps>>;
};
export const NO_MOTION: MotionState = Object.freeze({ surfaces: new Map(), camera: {}, focus: {} });

/** Quintic smootherstep: zero velocity and zero acceleration at both ends. */
export function cinematicProgress(progress: number): number {
  const t = Math.max(0, Math.min(1, progress));
  return t * t * t * (t * (t * 6 - 15) + 10);
}
export function ease(easing: Easing, progress: number): number {
  if (easing === "cinematic") return cinematicProgress(progress);
  if (easing === "easeInOut") return progress * progress * (3 - 2 * progress);
  return progress;
}

/** Value of one track at an authored time. Tracks hold their end values outside their keyframes. */
export function interpolate(frames: readonly Keyframe[], timeMs: number): number {
  const first = frames[0]!;
  if (timeMs <= first.timeMs) return first.value;
  for (let index = 1; index < frames.length; index++) {
    const end = frames[index]!;
    if (timeMs > end.timeMs) continue;
    const start = frames[index - 1]!;
    const weight = ease(start.easing, (timeMs - start.timeMs) / (end.timeMs - start.timeMs));
    // Convex form: exact at both ends and safe when the two values have opposite extremes.
    return (1 - weight) * start.value + weight * end.value;
  }
  return frames[frames.length - 1]!.value;
}

export function compileMotion(input: unknown): Result<Motion> {
  const parsed = MotionSchema.safeParse(input);
  return parsed.success ? ok(parsed.data) : fail(zodIssues(parsed.error, "invalid-motion"));
}

/** Presentation duration in milliseconds. */
export const motionDuration = (motion: Motion): number => motion.durationMs / motion.speed;

/** Authored time for an elapsed presentation time, clamped to the scene. */
export function motionTime(motion: Motion, elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs)) return 0;
  return Math.min(motion.durationMs, Math.max(0, elapsedMs) * motion.speed);
}

export function evaluateMotion(motion: Motion, elapsedMs: number): MotionState {
  const time = motionTime(motion, elapsedMs);
  // The schema guarantees each property belongs to its target, which a nested
  // discriminant cannot express to the type checker; write through plain records.
  const surfaces = new Map<string, Record<string, number>>();
  const camera: Record<string, number> = {};
  const focus: Record<string, number> = {};
  for (const track of motion.tracks) {
    const value = interpolate(track.keyframes, time);
    if (track.target.kind === "surface") {
      let entry = surfaces.get(track.target.id);
      if (!entry) surfaces.set(track.target.id, (entry = {}));
      entry[track.property] = value;
    } else if (track.target.kind === "camera") camera[track.property] = value;
    else focus[track.property] = value;
  }
  return { surfaces, camera, focus };
}
