import { describe, expect, it } from "vitest";
import { MUSIC_STYLES, MusicSchema, SceneRecipeSchema, SequenceSchema, TakeEditSchema, encodeWav, renderMusic } from "./index";

const rms = (samples: Float32Array, from = 0, to = samples.length) => {
  let sum = 0;
  for (let i = from; i < to; i++) sum += samples[i]! ** 2;
  return Math.sqrt(sum / Math.max(1, to - from));
};
const peak = (samples: Float32Array) => samples.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
const same = (a: Float32Array, b: Float32Array) => a.length === b.length && a.every((value, index) => value === b[index]);

describe("generated music", () => {
  it("is exactly as long as asked, in stereo, and never clips", () => {
    for (const style of MUSIC_STYLES) {
      const music = renderMusic({ style, seed: 3, durationMs: 6000 });
      expect(music.left.length).toBe(6 * 44100);
      expect(music.right.length).toBe(music.left.length);
      expect(peak(music.left), style).toBeLessThanOrEqual(0.81);
      expect(peak(music.right), style).toBeLessThanOrEqual(0.81);
      expect(rms(music.left), `${style} is audible`).toBeGreaterThan(0.05);
      expect(same(music.left, music.right), `${style} is true stereo`).toBe(false);
      expect(music.left.every(Number.isFinite)).toBe(true);
    }
  });

  it("is the same every time for the same style and seed, and different otherwise", () => {
    const first = renderMusic({ style: "upbeat", seed: 7, durationMs: 3000 });
    expect(same(first.left, renderMusic({ style: "upbeat", seed: 7, durationMs: 3000 }).left)).toBe(true);
    expect(same(first.left, renderMusic({ style: "upbeat", seed: 8, durationMs: 3000 }).left)).toBe(false);
    expect(same(first.left, renderMusic({ style: "lofi", seed: 7, durationMs: 3000 }).left)).toBe(false);
    // A longer render starts with the same music, so trimming a clip does not change its tune.
    const longer = renderMusic({ style: "upbeat", seed: 7, durationMs: 9000 });
    expect(same(longer.left.subarray(0, 44100), first.left.subarray(0, 44100))).toBe(true);
    expect(longer.bpm).toBe(first.bpm);
  });

  it("fades in from silence and out to silence", () => {
    for (const style of MUSIC_STYLES) {
      const music = renderMusic({ style, seed: 1, durationMs: 8000 });
      expect(Math.abs(music.left[0]!)).toBeLessThan(0.001);
      expect(Math.abs(music.left.at(-1)!)).toBeLessThan(0.001);
      expect(rms(music.left, 0, 2000)).toBeLessThan(rms(music.left, 3 * 44100, 4 * 44100));
      expect(rms(music.left, music.left.length - 2000)).toBeLessThan(rms(music.left, 3 * 44100, 4 * 44100) / 4);
    }
  });

  it("marks an accent with extra energy at that moment", () => {
    const plain = renderMusic({ style: "lofi", seed: 2, durationMs: 8000 });
    const accented = renderMusic({ style: "lofi", seed: 2, durationMs: 8000, accentsMs: [4000] });
    const window = [Math.round(3.9 * 44100), Math.round(4.3 * 44100)] as const;
    expect(same(plain.left, accented.left)).toBe(false);
    // Compare the difference between the two renders: it is concentrated around the accent.
    const difference = plain.left.map((value, index) => accented.left[index]! - value);
    expect(rms(difference, ...window)).toBeGreaterThan(rms(difference, 44100, 2 * 44100) * 5);
  });

  it("honours the sample rate it is asked for and survives a very short clip", () => {
    expect(renderMusic({ style: "lofi", seed: 1, durationMs: 1000, sampleRate: 48000 }).left.length).toBe(48000);
    const tiny = renderMusic({ style: "upbeat", seed: 1, durationMs: 40 });
    expect(tiny.left.length).toBe(Math.round(0.04 * 44100));
    expect(tiny.left.every(Number.isFinite)).toBe(true);
  });

  it("encodes a valid 16-bit stereo WAV", () => {
    const music = renderMusic({ style: "lofi", seed: 1, durationMs: 500 });
    const wav = encodeWav(music);
    const view = new DataView(wav.buffer);
    const text = (offset: number) => String.fromCharCode(...wav.subarray(offset, offset + 4));
    expect([text(0), text(8), text(12), text(36)]).toEqual(["RIFF", "WAVE", "fmt ", "data"]);
    expect([view.getUint16(22, true), view.getUint32(24, true), view.getUint16(34, true)]).toEqual([2, 44100, 16]);
    expect(wav.length).toBe(44 + music.left.length * 4);
    expect(view.getUint32(40, true)).toBe(music.left.length * 4);
  });
});

describe("music settings", () => {
  it("defaults to a moderate level that lowers under a voice", () => {
    expect(MusicSchema.parse({ style: "lofi" })).toEqual({ style: "lofi", seed: 1, gain: 0.5, duck: true });
    expect(MusicSchema.safeParse({ style: "jazz" }).success).toBe(false);
    expect(MusicSchema.safeParse({ style: "lofi", file: "song.mp3" }).success).toBe(false);
  });
  it("is accepted on scenes, takes and sequences", () => {
    const music = { style: "upbeat", seed: 42 };
    expect(SceneRecipeSchema.safeParse({ version: 1, id: "a", title: "A", definition: { scene: { nodes: [] } }, music }).success).toBe(true);
    expect(TakeEditSchema.safeParse({ trim: { startMs: 0, endMs: 1000 }, music }).success).toBe(true);
    expect(SequenceSchema.safeParse({ version: 1, id: "s", title: "S", items: [{ clip: { kind: "scene", id: "a" } }], music }).success).toBe(true);
  });
});
