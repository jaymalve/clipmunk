import type { TakeEvent } from "./take";

/** The synthetic cursor, as a pure function of the event log.
 * The recording has no cursor in it. The logged pointer path is resampled at a fixed
 * rate, smoothed with a zero-phase filter (so it does not lag behind the real pointer),
 * and pinned to the exact position of every click so the cursor never appears to miss.
 */
export type CursorStyle = "default" | "pointer" | "text";
export type CursorState = { x: number; y: number; style: CursorStyle; visible: boolean; pressed: boolean };
export type CursorClick = { t: number; x: number; y: number };
export type CursorPath = {
  at(timeMs: number): CursorState;
  clicks: CursorClick[];
  lastMoveBefore(timeMs: number): number;
};

const STEP_MS = 1000 / 120;
/** How far either side of a click the path is pulled toward the click position. */
const PIN_MS = 140;

export function prepareCursor(events: readonly TakeEvent[], smoothing: number): CursorPath {
  const points: { t: number; x: number; y: number }[] = [];
  const clicks: CursorClick[] = [];
  const styles: { t: number; style: CursorStyle }[] = [];
  const presses: { down: number; up: number }[] = [];
  for (const event of events) {
    if (event.k === "move" || event.k === "down" || event.k === "up") {
      const last = points.at(-1);
      if (last && event.t <= last.t) Object.assign(last, { x: event.x, y: event.y });
      else points.push({ t: event.t, x: event.x, y: event.y });
    }
    if (event.k === "down") {
      clicks.push({ t: event.t, x: event.x, y: event.y });
      presses.push({ down: event.t, up: Infinity });
    }
    if (event.k === "up" && presses.length) presses.at(-1)!.up = Math.max(event.t, presses.at(-1)!.down);
    if (event.k === "cursor") styles.push({ t: event.t, style: event.style });
  }
  const styleAt = (timeMs: number): CursorStyle => {
    let style: CursorStyle = "default";
    for (const change of styles) {
      if (change.t > timeMs) break;
      style = change.style;
    }
    return style;
  };
  const moveTimes = points.map((point) => point.t);
  const lastMoveBefore = (timeMs: number) => {
    let found = -Infinity;
    for (const t of moveTimes) {
      if (t > timeMs) break;
      found = t;
    }
    return found;
  };
  if (!points.length)
    return { at: () => ({ x: 0, y: 0, style: "default", visible: false, pressed: false }), clicks, lastMoveBefore };

  // Resample to a fixed rate so the filter behaves the same whatever the event rate was.
  // Held for a moment past the last event, so the smoothed path settles on the true final position.
  const start = points[0]!.t,
    end = points.at(-1)!.t + 600;
  const count = Math.max(1, Math.ceil((end - start) / STEP_MS) + 1);
  const xs = new Float64Array(count),
    ys = new Float64Array(count);
  for (let i = 0, segment = 0; i < count; i++) {
    const t = Math.min(end, start + i * STEP_MS);
    while (segment < points.length - 2 && points[segment + 1]!.t <= t) segment++;
    const a = points[segment]!,
      b = points[Math.min(segment + 1, points.length - 1)]!;
    const weight = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0;
    xs[i] = a.x + (b.x - a.x) * weight;
    ys[i] = a.y + (b.y - a.y) * weight;
  }
  // Forward then backward exponential smoothing: the two phase delays cancel.
  const tau = Math.max(0, Math.min(1, smoothing)) * 90;
  if (tau > 0) {
    const alpha = 1 - Math.exp(-STEP_MS / tau);
    for (const values of [xs, ys]) {
      for (let i = 1; i < count; i++) values[i] = values[i - 1]! + alpha * (values[i]! - values[i - 1]!);
      for (let i = count - 2; i >= 0; i--) values[i] = values[i + 1]! + alpha * (values[i]! - values[i + 1]!);
    }
    // Smoothing rounds off the corner at a click; pull the path back so it passes through the click exactly.
    for (const click of clicks) {
      const from = Math.max(0, Math.floor((click.t - PIN_MS - start) / STEP_MS)),
        to = Math.min(count - 1, Math.ceil((click.t + PIN_MS - start) / STEP_MS));
      for (let i = from; i <= to; i++) {
        const distance = Math.abs(start + i * STEP_MS - click.t) / PIN_MS;
        const pull = distance >= 1 ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * distance);
        xs[i] = xs[i]! + (click.x - xs[i]!) * pull;
        ys[i] = ys[i]! + (click.y - ys[i]!) * pull;
      }
    }
  }
  return {
    clicks,
    lastMoveBefore,
    at(timeMs) {
      const position = Math.min(count - 1, Math.max(0, (timeMs - start) / STEP_MS));
      const i = Math.floor(position),
        j = Math.min(count - 1, i + 1),
        weight = position - i;
      return {
        x: xs[i]! + (xs[j]! - xs[i]!) * weight,
        y: ys[i]! + (ys[j]! - ys[i]!) * weight,
        style: styleAt(timeMs),
        visible: timeMs >= start,
        pressed: presses.some((press) => timeMs >= press.down && timeMs <= press.up),
      };
    },
  };
}

/** Parse events.jsonl, keeping only lines that match the schema. */
export function parseEvents(
  text: string,
  schema: { safeParse(input: unknown): { success: true; data: TakeEvent } | { success: false } },
): TakeEvent[] {
  const events: TakeEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const parsed = schema.safeParse(JSON.parse(line));
      if (parsed.success) events.push(parsed.data);
    } catch {
      // skip a damaged line
    }
  }
  return events;
}
