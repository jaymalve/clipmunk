import { describe, expect, it } from "vitest";
import { buildTimeMap, defaultEdit, detectSpeech, mapOf, type TakeEdit, type TakeEvent, trimMap } from "./index";

const paced = (durationMs: number, pace: Partial<{ deadAir: boolean; typing: boolean }> = {}): TakeEdit => {
  const edit = defaultEdit(durationMs);
  return {
    ...edit,
    pace: {
      deadAir: { ...edit.pace.deadAir, on: pace.deadAir ?? true },
      typing: { ...edit.pace.typing, on: pace.typing ?? true },
    },
  };
};
const move = (t: number): TakeEvent => ({ t, k: "move", x: 1, y: 1 });
const type = (t: number): TakeEvent => ({ t, k: "type", rect: [0, 0, 10, 10] });

describe("time map", () => {
  it("is the trim alone when pacing is off", () => {
    const edit = { ...defaultEdit(10_000), trim: { startMs: 1000, endMs: 7000 } };
    const map = buildTimeMap(edit, [move(1500), move(6000)]);
    expect(map.durationMs).toBe(6000);
    expect(map.segments).toEqual([{ fromMs: 1000, toMs: 7000, speed: 1 }]);
    expect(map.toTake(0)).toBe(1000);
    expect(map.toTake(2500)).toBe(3500);
    expect(map.toClip(3500)).toBe(2500);
    expect(map.toClip(0)).toBe(0); // clamped to the trim
    expect(map.toClip(9000)).toBe(6000);
    expect(trimMap(edit.trim)).toMatchObject({ durationMs: 6000, segments: map.segments });
  });

  it("plays a gap with no input fast, keeping half the allowed gap at normal speed each side", () => {
    // Input until 1000 ms, then nothing until 5000 ms: 4 s idle, of which 3.4 s plays at 4x.
    const map = buildTimeMap(paced(6000), [move(0), move(500), move(1000), move(5000), move(5500), move(6000)]);
    expect(map.segments).toEqual([
      { fromMs: 0, toMs: 1300, speed: 1 },
      { fromMs: 1300, toMs: 4700, speed: 4 },
      { fromMs: 4700, toMs: 6000, speed: 1 },
    ]);
    expect(map.durationMs).toBe(6000 - 3400 * 0.75);
    expect(map.speedAt(1500)).toBe(4);
    expect(map.speedAt(500)).toBe(1);
  });

  it("treats the stretch before the first input and after the last as idle too", () => {
    const map = buildTimeMap(paced(10_000), [move(3000)]);
    expect(map.segments.map((segment) => segment.speed)).toEqual([4, 1, 4]);
    expect(map.segments[0]).toEqual({ fromMs: 0, toMs: 2700, speed: 4 });
    expect(map.segments[2]).toEqual({ fromMs: 3300, toMs: 10_000, speed: 4 });
  });

  it("speeds up runs of typing, and never what is spoken", () => {
    const keys = Array.from({ length: 11 }, (_, index) => type(1000 + index * 200)); // 1000..3000
    const typing = buildTimeMap(paced(4000, { deadAir: false }), keys);
    expect(typing.segments).toEqual([
      { fromMs: 0, toMs: 1000, speed: 1 },
      { fromMs: 1000, toMs: 3000, speed: 2 },
      { fromMs: 3000, toMs: 4000, speed: 1 },
    ]);
    // Speech from 1500 to 2000 keeps that part (and 200 ms either side) at normal speed.
    const spoken = buildTimeMap(paced(4000, { deadAir: false }), keys, [[1500, 2000]]);
    expect(spoken.segments).toEqual([
      { fromMs: 0, toMs: 1000, speed: 1 },
      { fromMs: 1000, toMs: 1300, speed: 2 },
      { fromMs: 1300, toMs: 2200, speed: 1 },
      { fromMs: 2200, toMs: 3000, speed: 2 },
      { fromMs: 3000, toMs: 4000, speed: 1 },
    ]);
    // Two or fewer keystrokes are not a run, and an idle gap full of speech stays as it is.
    expect(buildTimeMap(paced(4000, { deadAir: false }), [type(1000), type(1200)]).segments).toHaveLength(1);
    expect(buildTimeMap(paced(6000), [move(0), move(6000)], [[0, 6000]]).segments).toHaveLength(1);
  });

  it("is monotonic and its two directions are inverse", () => {
    const keys = Array.from({ length: 8 }, (_, index) => type(4000 + index * 300));
    const map = buildTimeMap({ ...paced(12_000), trim: { startMs: 500, endMs: 11_000 } }, [
      move(800),
      ...keys,
      move(9000),
    ]);
    let previous = -1;
    for (let clip = 0; clip <= map.durationMs; clip += 7) {
      const take = map.toTake(clip);
      expect(take).toBeGreaterThan(previous);
      expect(map.toClip(take)).toBeCloseTo(clip, 6);
      previous = take;
    }
    expect(map.toTake(map.durationMs)).toBe(11_000);
    // Segments tile the trim.
    expect(map.segments[0]!.fromMs).toBe(500);
    for (const [index, segment] of map.segments.slice(1).entries())
      expect(segment.fromMs).toBe(map.segments[index]!.toMs);
  });

  it("maps any tiling of segments", () => {
    const map = mapOf([
      { fromMs: 0, toMs: 1000, speed: 1 },
      { fromMs: 1000, toMs: 3000, speed: 2 },
    ]);
    expect(map.durationMs).toBe(2000);
    expect(map.toTake(1500)).toBe(2000);
    expect(map.toClip(2000)).toBe(1500);
  });
});

describe("speech detection", () => {
  const rate = 8000;
  const signal = (parts: [seconds: number, amplitude: number][]) => {
    const out: number[] = [];
    for (const [seconds, amplitude] of parts)
      for (let index = 0; index < seconds * rate; index++)
        out.push(amplitude * Math.sin((2 * Math.PI * 220 * out.length) / rate) + 0.0005 * Math.sin(out.length));
    return out;
  };

  it("finds loud stretches over the room's noise, joining short pauses", () => {
    const spans = detectSpeech(
      signal([
        [1, 0],
        [0.8, 0.3],
        [0.1, 0],
        [0.5, 0.3],
        [1, 0],
      ]),
      rate,
    );
    expect(spans).toHaveLength(1);
    expect(spans[0]![0]).toBeCloseTo(1000, -2);
    expect(spans[0]![1]).toBeCloseTo(2400, -2);
  });

  it("ignores blips and finds nothing in silence", () => {
    expect(
      detectSpeech(
        signal([
          [1, 0],
          [0.06, 0.5],
          [1, 0],
        ]),
        rate,
      ),
    ).toEqual([]);
    expect(detectSpeech(signal([[2, 0]]), rate)).toEqual([]);
    expect(detectSpeech([], rate)).toEqual([]);
  });

  it("treats a voice that never stops as speech throughout", () => {
    const spans = detectSpeech(signal([[2, 0.12]]), rate);
    expect(spans).toEqual([[0, 2000]]);
  });
});
