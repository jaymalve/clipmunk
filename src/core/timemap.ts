import type { TakeEdit, TakeEvent } from "./take";

/** The one place that maps between a take's two clocks. Take time is the recording's own clock;
 * clip time (presentation time) starts at zero at the trim start and is what plays. Pacing
 * speeds up idle gaps and runs of typing, so the map is piecewise linear: each segment of take
 * time plays at its own speed. With pacing off it is the trim alone.
 */
export type Span = [fromMs: number, toMs: number];
export type TimeSegment = { fromMs: number; toMs: number; speed: number };
export type TimeMap = {
  /** Contiguous, in order, covering the trim. */
  readonly segments: readonly TimeSegment[];
  /** How long the clip plays. */
  readonly durationMs: number;
  toTake(clipMs: number): number;
  /** Clip time at a take time; take times outside the trim are clamped to it. */
  toClip(takeMs: number): number;
  /** The speed at a clip time. */
  speedAt(clipMs: number): number;
};

/** Typing is a run of keystrokes no further apart than this, at least TYPING_MIN keys long. */
const TYPING_GAP_MS = 1000,
  TYPING_MIN = 3;
/** Shorter fast spans are not worth the jump in speed. */
const MIN_FAST_MS = 250;
/** Speech is kept at normal speed with this much room either side. */
const SPEECH_PAD_MS = 200;
/** What counts as input for dead air: anything the user did. Page activity alone (a `redact` box moving) is not. */
const INPUT = new Set<TakeEvent["k"]>(["move", "down", "up", "scroll", "type", "combo", "focus"]);

export function buildTimeMap(
  edit: Pick<TakeEdit, "trim" | "pace">,
  events: readonly TakeEvent[],
  speech: readonly Span[] = [],
): TimeMap {
  const { startMs, endMs } = edit.trim;
  const { deadAir, typing } = edit.pace;
  const inside = (span: Span): Span => [Math.max(startMs, span[0]), Math.min(endMs, span[1])];
  const spoken = speech.map(([from, to]): Span => [from - SPEECH_PAD_MS, to + SPEECH_PAD_MS]);

  let typed: Span[] = [];
  if (typing.on && typing.speed > 1) {
    const keys = events.filter((event) => event.k === "type").map((event) => event.t);
    keys.sort((a, b) => a - b);
    let run: number[] = [];
    const close = () => {
      if (run.length >= TYPING_MIN) typed.push([run[0]!, run.at(-1)!]);
      run = [];
    };
    for (const t of keys) {
      if (run.length && t - run.at(-1)! > TYPING_GAP_MS) close();
      run.push(t);
    }
    close();
    typed = subtract(typed.map(inside), spoken);
  }

  let idle: Span[] = [];
  if (deadAir.on && deadAir.speed > 1) {
    const times = events.filter((event) => INPUT.has(event.k)).map((event) => event.t);
    times.sort((a, b) => a - b);
    // The gap keeps maxGapMs at normal speed, half at each end, so actions never start abruptly.
    const pad = deadAir.maxGapMs / 2;
    const marks = [startMs - pad, ...times.filter((t) => t > startMs && t < endMs), endMs + pad];
    for (let index = 1; index < marks.length; index++) {
      const from = marks[index - 1]!,
        to = marks[index]!;
      if (to - from > deadAir.maxGapMs) idle.push(inside([from + pad, to - pad]));
    }
    idle = subtract(subtract(idle, spoken), typed);
  }

  const fast = [
    ...typed.map((span) => ({ span, speed: typing.speed })),
    ...idle.map((span) => ({ span, speed: deadAir.speed })),
  ]
    .filter(({ span }) => span[1] - span[0] >= MIN_FAST_MS)
    .sort((a, b) => a.span[0] - b.span[0]);
  const segments: TimeSegment[] = [];
  let at = startMs;
  for (const { span, speed } of fast) {
    if (span[0] > at) segments.push({ fromMs: at, toMs: span[0], speed: 1 });
    segments.push({ fromMs: span[0], toMs: span[1], speed });
    at = span[1];
  }
  if (endMs > at || !segments.length) segments.push({ fromMs: at, toMs: Math.max(at, endMs), speed: 1 });
  return mapOf(segments);
}

/** The map for segments that tile a stretch of take time. */
export function mapOf(segments: readonly TimeSegment[]): TimeMap {
  const starts: number[] = [];
  let total = 0;
  for (const segment of segments) {
    starts.push(total);
    total += (segment.toMs - segment.fromMs) / segment.speed;
  }
  const first = segments[0]!,
    last = segments.at(-1)!;
  /** The segment whose clip span holds `clipMs`. */
  const byClip = (clipMs: number) => {
    let low = 0,
      high = segments.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle]! <= clipMs) low = middle;
      else high = middle - 1;
    }
    return low;
  };
  return {
    segments,
    durationMs: total,
    toTake(clipMs) {
      if (clipMs <= 0) return first.fromMs;
      if (clipMs >= total) return last.toMs;
      const index = byClip(clipMs);
      const segment = segments[index]!;
      return segment.fromMs + (clipMs - starts[index]!) * segment.speed;
    },
    toClip(takeMs) {
      if (takeMs <= first.fromMs) return 0;
      if (takeMs >= last.toMs) return total;
      let low = 0,
        high = segments.length - 1;
      while (low < high) {
        const middle = (low + high + 1) >> 1;
        if (segments[middle]!.fromMs <= takeMs) low = middle;
        else high = middle - 1;
      }
      const segment = segments[low]!;
      return starts[low]! + (takeMs - segment.fromMs) / segment.speed;
    },
    speedAt(clipMs) {
      return segments[byClip(Math.max(0, Math.min(total, clipMs)))]!.speed;
    },
  };
}

/** The trim alone, at normal speed. */
export const trimMap = (trim: TakeEdit["trim"]): TimeMap =>
  mapOf([{ fromMs: trim.startMs, toMs: Math.max(trim.startMs, trim.endMs), speed: 1 }]);

/** `spans` with every part covered by `cuts` removed. Both are lists of [from, to]. */
function subtract(spans: readonly Span[], cuts: readonly Span[]): Span[] {
  let out = spans.filter(([from, to]) => to > from);
  for (const [cutFrom, cutTo] of cuts) {
    out = out.flatMap(([from, to]): Span[] => {
      if (cutTo <= from || cutFrom >= to) return [[from, to]];
      const parts: Span[] = [];
      if (cutFrom > from) parts.push([from, cutFrom]);
      if (cutTo < to) parts.push([cutTo, to]);
      return parts;
    });
  }
  return out;
}

/** Where speech is in a mono recording, from its loudness in 20 ms frames, in milliseconds on
 * the file's own clock. The threshold sits above the room's noise floor, within fixed bounds,
 * so a quiet room and a noisy one both work; short blips are dropped and short pauses joined.
 */
export function detectSpeech(samples: ArrayLike<number>, sampleRate: number): Span[] {
  const frame = Math.max(1, Math.round(sampleRate * 0.02));
  const levels: number[] = [];
  for (let start = 0; start + frame <= samples.length; start += frame) {
    let sum = 0;
    for (let index = start; index < start + frame; index++) sum += samples[index]! * samples[index]!;
    levels.push(10 * Math.log10(sum / frame + 1e-12));
  }
  if (!levels.length) return [];
  const floor = [...levels].sort((a, b) => a - b)[Math.floor(levels.length * 0.1)]!;
  const threshold = Math.max(-50, Math.min(-35, floor + 10));
  const spans: Span[] = [];
  levels.forEach((level, index) => {
    if (level < threshold) return;
    const from = index * 20,
      to = from + 20;
    const last = spans.at(-1);
    if (last && from - last[1] <= 300) last[1] = to;
    else spans.push([from, to]);
  });
  return spans.filter(([from, to]) => to - from >= 120);
}
