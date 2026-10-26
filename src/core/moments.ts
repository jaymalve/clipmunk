import type { SceneDefinition } from "./recipe";
import type { TakeEvent } from "./take";
import type { TimeMap } from "./timemap";

/** The moments in a clip that music can be lined up with: when something arrives on screen
 * in a scene, and when the action happens in a take. Times are in clip milliseconds, the
 * same clock the player and the exporter use.
 */
const merge = (times: number[], gapMs: number): number[] => {
  const out: number[] = [];
  for (const time of [...times].sort((a, b) => a - b))
    if (!out.length || time - out.at(-1)! >= gapMs) out.push(Math.round(time));
  return out;
};

/** A surface "arrives" when its entrance finishes: the last keyframe of any of its tracks
 * that actually moves or fades it. Camera and focus moves are continuous travel, not arrivals.
 */
export function sceneMoments(definition: Pick<SceneDefinition, "motion">): number[] {
  const motion = definition.motion;
  if (!motion) return [];
  const arrivals = new Map<string, number>();
  for (const track of motion.tracks) {
    if (track.target.kind !== "surface") continue;
    const frames = track.keyframes;
    if (frames.length < 2 || frames.every((frame) => frame.value === frames[0]!.value)) continue;
    arrivals.set(track.target.id, Math.max(arrivals.get(track.target.id) ?? 0, frames.at(-1)!.timeMs));
  }
  // Authored time runs at `speed`; the clip's clock is presentation time.
  return merge(
    [...arrivals.values()].map((time) => time / motion.speed),
    250,
  );
}

/** The first click of each burst of activity, on the clip's clock (after trim and pacing). */
export function takeMoments(map: TimeMap, events: readonly TakeEvent[]): number[] {
  const first = map.segments[0]!.fromMs,
    last = map.segments.at(-1)!.toMs;
  const clicks = events
    .filter((event) => event.k === "down" && event.t >= first && event.t <= last)
    .map((event) => map.toClip(event.t));
  return merge(clicks, 1200);
}
