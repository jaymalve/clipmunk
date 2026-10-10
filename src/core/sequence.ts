import { z } from "zod";
import { fail, ok, zodIssues, type Result } from "./result";
import { AudioClipSchema } from "./audio";
import { ClipIdSchema } from "./recipe";

/** A sequence joins scenes and takes into one video. It is a small JSON file in the host
 * repo, next to the scenes, so a person, the studio or a coding agent can all write it.
 */
export const SEQUENCES_DIR = "src/flick/sequences";
export const SEQUENCE_PARAM = "flick-sequence";

export const SequenceItemSchema = z.strictObject({
  clip: z.strictObject({ kind: z.enum(["scene", "take"]), id: ClipIdSchema }),
  /** How this item arrives from the one before it. Ignored on the first item. A fade overlaps the two. */
  transition: z.strictObject({ kind: z.enum(["cut", "fade"]), ms: z.number().finite().min(0).max(5000).default(500) }).prefault({ kind: "cut" }),
});
export type SequenceItem = z.output<typeof SequenceItemSchema>;

export const SequenceSchema = z.strictObject({
  version: z.literal(1),
  id: ClipIdSchema,
  title: z.string().trim().min(1),
  width: z.number().int().min(64).max(3840).multipleOf(2).default(1920),
  height: z.number().int().min(64).max(3840).multipleOf(2).default(1080),
  fps: z.union([z.literal(30), z.literal(60)]).default(60),
  items: z.array(SequenceItemSchema).min(1).max(100),
  /** Sound laid over the whole sequence: music or a voiceover recorded elsewhere. */
  audio: z.array(AudioClipSchema).max(16).optional(),
});
export type Sequence = z.output<typeof SequenceSchema>;
export type SequenceInput = z.input<typeof SequenceSchema>;

export function validateSequence(input: unknown): Result<Sequence> {
  const parsed = SequenceSchema.safeParse(input);
  return parsed.success ? ok(parsed.data) : fail(zodIssues(parsed.error, "invalid-sequence"));
}

/** Where each item starts and how long the whole sequence runs, given each clip's length.
 * A fade of `ms` overlaps the two clips, so it shortens the total by `ms`; it is capped at
 * half of the shorter neighbour so a clip is never entirely inside its transitions.
 */
export function planSequence(items: readonly SequenceItem[], durationsMs: readonly number[]): { startsMs: number[]; fadesMs: number[]; totalMs: number } {
  const startsMs: number[] = [], fadesMs: number[] = [];
  let cursor = 0;
  items.forEach((item, index) => {
    const duration = durationsMs[index] ?? 0;
    const fade = index > 0 && item.transition.kind === "fade" ? Math.max(0, Math.min(item.transition.ms, duration / 2, durationsMs[index - 1]! / 2)) : 0;
    fadesMs.push(fade);
    startsMs.push(cursor - fade);
    cursor += duration - fade;
  });
  return { startsMs, fadesMs, totalMs: cursor };
}
