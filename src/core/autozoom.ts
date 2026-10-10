import { interpolate, type Keyframe } from "./motion";
import type { AutoZoomParams, TakeEdit, TakeEvent, ZoomTrack } from "./take";

/** Automatic zoom for a take, as a pure function of its event log.
 * Clicks and typing are "activity". Activity close together in time becomes one zoom
 * segment: ease in just before it starts, hold, pan when the action moves away, ease out
 * after it ends. The result is three ordinary keyframe tracks (x, y, scale) that anyone
 * could have written by hand, and that `edit.zoom.mode = "manual"` stores verbatim.
 */
export type ZoomView = { x: number; y: number; scale: number };
export type ZoomSegment = { startMs: number; endMs: number; scale: number };
type Size = { width: number; height: number };
type Activity = { t: number; x: number; y: number; width: number; height: number };

/** The part of the view, around its centre, the action may move in before the view follows it. */
const SAFE_AREA = 0.62;

function activities(events: readonly TakeEvent[], source: Size): Activity[] {
  const out: Activity[] = [];
  for (const event of events) {
    if (event.k !== "down" && event.k !== "type") continue;
    const [left, top, width, height] = event.rect;
    // A click on the page background reports a box as large as the page: aim at the pointer instead.
    const huge = width * height > source.width * source.height * 0.45;
    if (event.k === "down" && (huge || width <= 0 || height <= 0)) out.push({ t: event.t, x: event.x, y: event.y, width: source.width * 0.3, height: source.height * 0.3 });
    else out.push({ t: event.t, x: left + width / 2, y: top + height / 2, width, height });
  }
  return out.sort((a, b) => a.t - b.t);
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** Keep the zoomed view inside the recording. At scale 1 the only valid centre is the middle. */
export function clampView(view: ZoomView, source: Size): ZoomView {
  const scale = Math.max(1, view.scale);
  const halfWidth = source.width / (2 * scale), halfHeight = source.height / (2 * scale);
  return { scale, x: clamp(view.x, halfWidth, source.width - halfWidth), y: clamp(view.y, halfHeight, source.height - halfHeight) };
}

export function generateZoomTracks(events: readonly TakeEvent[], source: Size & { durationMs: number }, params: AutoZoomParams): ZoomTrack[] {
  const list = activities(events, source);
  if (!list.length || params.maxScale <= 1) return [];
  const segments: Activity[][] = [];
  for (const activity of list) {
    const current = segments.at(-1);
    if (current && activity.t - current.at(-1)!.t <= params.mergeGapMs) current.push(activity);
    else segments.push([activity]);
  }
  const middle = { x: source.width / 2, y: source.height / 2 };
  const frames: { t: number; view: ZoomView }[] = [{ t: 0, view: { ...middle, scale: 1 } }];
  const push = (t: number, view: ZoomView) => {
    const time = clamp(Math.round(t), 0, source.durationMs);
    const last = frames.at(-1)!;
    // Keyframe times must strictly increase; a later instruction for the same instant wins.
    if (time <= last.t) last.view = view;
    else frames.push({ t: time, view });
  };

  for (const segment of segments) {
    // One magnification per segment, small enough that its largest target still fits comfortably.
    const scale = clamp(Math.min(...segment.map((a) => Math.min(source.width / a.width, source.height / a.height) * 0.5)), params.minScale, params.maxScale);
    const viewAt = (activity: Activity) => clampView({ x: activity.x, y: activity.y, scale }, source);
    const first = segment[0]!, last = segment.at(-1)!;
    let view = viewAt(first);
    const previous = frames.at(-1)!;
    const arrive = first.t - params.leadMs;
    // Rest at full view until it is time to move, unless the previous segment has not finished easing out.
    if (previous.view.scale === 1) push(Math.max(previous.t, arrive - params.easeMs), { ...middle, scale: 1 });
    push(arrive, view);
    for (const activity of segment.slice(1)) {
      const outside = Math.abs(activity.x - view.x) > (source.width / scale / 2) * SAFE_AREA || Math.abs(activity.y - view.y) > (source.height / scale / 2) * SAFE_AREA;
      if (!outside) continue;
      const land = activity.t - params.leadMs;
      push(Math.max(frames.at(-1)!.t, land - params.easeMs), view); // hold, then pan
      view = viewAt(activity);
      push(land, view);
    }
    push(last.t + params.holdMs, view);
    push(last.t + params.holdMs + params.easeMs, { ...middle, scale: 1 });
  }
  const track = (property: "x" | "y" | "scale"): ZoomTrack => ({
    target: { kind: "zoom" },
    property,
    keyframes: frames.map((frame) => ({ timeMs: frame.t, value: Math.round(frame.view[property] * 1000) / 1000, easing: "cinematic" })),
  });
  return [track("x"), track("y"), track("scale")];
}

/** The zoom tracks a take's edit asks for: generated, hand-written or none. */
export function resolveZoomTracks(edit: Pick<TakeEdit, "zoom">, events: readonly TakeEvent[], source: Size & { durationMs: number }): ZoomTrack[] {
  if (edit.zoom.mode === "off") return [];
  if (edit.zoom.mode === "manual") return edit.zoom.tracks;
  return generateZoomTracks(events, source, edit.zoom.params);
}

/** The view at a take time. Missing tracks mean the full, unzoomed recording. */
export function zoomAt(tracks: readonly ZoomTrack[], timeMs: number, source: Size): ZoomView {
  const value = (property: ZoomTrack["property"], fallback: number) => {
    const track = tracks.find((candidate) => candidate.property === property);
    return track ? interpolate(track.keyframes as Keyframe[], timeMs) : fallback;
  };
  return clampView({ x: value("x", source.width / 2), y: value("y", source.height / 2), scale: value("scale", 1) }, source);
}

/** Where the view is zoomed in, for drawing on a timeline. */
export function zoomSegments(tracks: readonly ZoomTrack[]): ZoomSegment[] {
  const frames = tracks.find((track) => track.property === "scale")?.keyframes ?? [];
  const segments: ZoomSegment[] = [];
  let open: ZoomSegment | undefined;
  frames.forEach((frame, index) => {
    const next = frames[index + 1];
    if (!open && next && frame.value <= 1 && next.value > 1) open = { startMs: frame.timeMs, endMs: frame.timeMs, scale: next.value };
    if (!open && index === 0 && frame.value > 1) open = { startMs: frame.timeMs, endMs: frame.timeMs, scale: frame.value };
    if (open) {
      open.endMs = frame.timeMs;
      open.scale = Math.max(open.scale, frame.value);
      if (frame.value <= 1 && frame.timeMs > open.startMs) {
        segments.push(open);
        open = undefined;
      }
    }
  });
  if (open) segments.push(open);
  return segments;
}
