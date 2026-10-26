import { interpolate, type Keyframe } from "./motion";
import type { Ratio, TakeEvent } from "./take";

/** Reframing a take to a shape narrower than its recording: a crop window, as tall as the
 * recording, that follows the elements the user clicks. It moves with the same easing and lead
 * as auto-zoom, and it is placed so that every clicked element's box is inside it from the
 * moment of the click until the button is released, whenever the box fits at all.
 */
export type Size = { width: number; height: number };
export type CropPath = {
  /** The window's width in source CSS pixels; the source's own width when nothing is cropped. */
  readonly width: number;
  readonly crops: boolean;
  /** The window's left edge at a take time. */
  at(timeMs: number): number;
};

/** The canvas for a ratio: 1080 pixels on the short side. */
export function ratioCanvas(ratio: Ratio): Size {
  const [w, h] = ratio.split(":").map(Number) as [number, number];
  const scale = 1080 / Math.min(w, h);
  const even = (value: number) => Math.round(value / 2) * 2;
  return { width: even(w * scale), height: even(h * scale) };
}

const LEAD_MS = 300,
  EASE_MS = 700,
  /** How long a click holds the window when the log has no `up` for it. */
  PRESS_MS = 120;

/** The crop for a window of `aspect` (width over height) over `source`. */
export function reframePath(events: readonly TakeEvent[], source: Size, aspect: number): CropPath {
  const width = Math.min(source.width, source.height * aspect);
  if (width >= source.width - 0.5) return { width: source.width, crops: false, at: () => 0 };
  const half = width / 2;
  const clampCentre = (x: number) => Math.max(half, Math.min(source.width - half, x));

  const downs = events.filter((event) => event.k === "down").sort((a, b) => a.t - b.t);
  const ups = events.filter((event) => event.k === "up").sort((a, b) => a.t - b.t);
  const clicks = downs.map((down) => {
    const [x, , w] = down.rect;
    const up = ups.find((candidate) => candidate.t >= down.t);
    return {
      t: down.t,
      until: Math.max(down.t, up ? up.t : down.t + PRESS_MS),
      // The box's centre, or the pointer for a box as wide as the page (a click on the background).
      centre: clampCentre(w >= source.width * 0.9 ? down.x : x + w / 2),
    };
  });
  const frames: Keyframe[] = [{ timeMs: 0, value: clicks[0]?.centre ?? source.width / 2, easing: "cinematic" }];
  let held = clicks[0]?.until ?? 0;
  for (const click of clicks.slice(1)) {
    const last = frames.at(-1)!;
    if (Math.abs(click.centre - last.value) < 0.5) {
      held = Math.max(held, click.until);
      continue;
    }
    // Leave after the previous press ends, arrive by the lead before this click, and never after it.
    const start = Math.max(last.timeMs, held);
    const arrive = Math.min(click.t, Math.max(start + 1, click.t - LEAD_MS));
    if (arrive <= start) {
      // Two presses at once: the newer one wins.
      last.value = click.centre;
    } else {
      const depart = Math.max(start, arrive - EASE_MS);
      if (depart > last.timeMs) frames.push({ timeMs: depart, value: last.value, easing: "cinematic" });
      else last.easing = "cinematic";
      frames.push({ timeMs: arrive, value: click.centre, easing: "cinematic" });
    }
    held = click.until;
  }
  return { width, crops: true, at: (timeMs) => interpolate(frames, timeMs) - half };
}
