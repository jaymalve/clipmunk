import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  defaultEdit,
  encodeWav,
  fitTempo,
  MUSIC_STYLES,
  MusicSchema,
  planMusic,
  renderMusic,
  SceneRecipeSchema,
  SequenceSchema,
  sceneMoments,
  seedFor,
  styleTempo,
  TakeEditSchema,
  type TakeEvent,
  takeMoments,
  validateRecipe,
} from "./index";

const rms = (samples: Float32Array, from = 0, to = samples.length) => {
  let sum = 0;
  for (let i = from; i < to; i++) sum += samples[i]! ** 2;
  return Math.sqrt(sum / Math.max(1, to - from));
};
const peak = (samples: Float32Array) => samples.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
const same = (a: Float32Array, b: Float32Array) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

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

describe("the launch style", () => {
  // The launch video's joins: the drop lands on the second, and the end hit on the last.
  const joins = [1800, 4400, 8600, 12400, 17000, 22000, 25000, 28600];
  // Rendered once and shared: a 32 second render takes a moment.
  let rendered: ReturnType<typeof renderMusic> | undefined;
  const render = () =>
    (rendered ??= renderMusic(
      planMusic(
        { style: "launch", gain: 0.5, duck: true, sync: true },
        { key: "sequence:launch", durationMs: 32000, momentsMs: joins, accentLevel: 1 },
      ),
    ));
  const at = (seconds: number) => Math.round(seconds * 44100);

  it("stays quiet in the intro and drops on the first moment a bar or more in", () => {
    const music = render();
    const intro = rms(music.left, at(0.5), at(3.5));
    const drop = rms(music.left, at(4.5), at(7.5));
    expect(drop).toBeGreaterThan(intro * 2);
  });

  it("keeps playing through the cuts between the drop and the ending, and marks each one", () => {
    const music = render();
    for (const cut of [8.6, 12.4, 17.0, 22.0, 25.0]) {
      expect(rms(music.left, at(cut - 0.4), at(cut - 0.05)), `before ${cut}`).toBeGreaterThan(0.02);
      expect(rms(music.left, at(cut), at(cut + 0.3)), `after ${cut}`).toBeGreaterThan(0.02);
    }
  });

  it("nudges its tempo so the ending lands on a bar line of the beat", () => {
    const music = render();
    const bars = ((28.6 - 4.4) * music.bpm) / 240;
    expect(Math.abs(bars - Math.round(bars))).toBeLessThan(0.002);
    expect(Math.abs(music.bpm / 78.5 - 1)).toBeLessThanOrEqual(0.04);
  });

  it("lands the ending on its moment after a silence, so it never falls between beats", () => {
    const music = render();
    // The one break: the music stops two sixteenths before the end card, then hits on it.
    expect(rms(music.left, at(28.25), at(28.59))).toBe(0);
    expect(rms(music.left, at(28.6), at(28.7))).toBeGreaterThan(0.1);
  });

  it("ends with a hit on the last moment that rings out and fades", () => {
    const music = render();
    const hit = rms(music.left, at(28.6), at(29.0));
    const before = rms(music.left, at(27.6), at(28.4));
    const tail = rms(music.left, at(30.5), at(31.5));
    expect(hit).toBeGreaterThan(tail * 4);
    expect(tail).toBeLessThan(before / 4);
  });

  it("is the same every time for the same moments and seed", () => {
    const request = { style: "launch", seed: 9, durationMs: 6000, accentsMs: [4400] } as const;
    expect(same(renderMusic(request).left, renderMusic(request).left)).toBe(true);
    expect(same(renderMusic(request).left, renderMusic({ ...request, seed: 10 }).left)).toBe(false);
  });

  it("still makes music for a short clip with no moments", () => {
    const music = renderMusic({ style: "launch", seed: 5, durationMs: 4000 });
    expect(rms(music.left, at(1), at(3))).toBeGreaterThan(0.05);
  });
});

describe("music settings", () => {
  it("defaults to a moderate level that lowers under a voice", () => {
    expect(MusicSchema.parse({ style: "lofi" })).toEqual({ style: "lofi", gain: 0.5, duck: true, sync: true });
    expect(MusicSchema.safeParse({ style: "jazz" }).success).toBe(false);
    expect(MusicSchema.safeParse({ style: "lofi", file: "song.mp3" }).success).toBe(false);
  });
  it("is accepted on scenes, takes and sequences", () => {
    const music = { style: "upbeat", seed: 42 };
    expect(
      SceneRecipeSchema.safeParse({ version: 1, id: "a", title: "A", definition: { scene: { nodes: [] } }, music })
        .success,
    ).toBe(true);
    expect(TakeEditSchema.safeParse({ trim: { startMs: 0, endMs: 1000 }, music }).success).toBe(true);
    expect(
      SequenceSchema.safeParse({
        version: 1,
        id: "s",
        title: "S",
        items: [{ clip: { kind: "scene", id: "a" } }],
        music,
      }).success,
    ).toBe(true);
  });
});

describe("a tune for every clip", () => {
  it("derives a stable, different tune from each clip's name unless one was chosen", () => {
    const music = MusicSchema.parse({ style: "upbeat" });
    const a = planMusic(music, { key: "scene:intro", durationMs: 5000 }),
      b = planMusic(music, { key: "scene:pricing", durationMs: 5000 });
    expect(a.seed).toBe(seedFor("scene:intro"));
    expect(a.seed).toBe(planMusic(music, { key: "scene:intro", durationMs: 9000 }).seed);
    expect(a.seed).not.toBe(b.seed);
    expect(seedFor("take:intro")).not.toBe(seedFor("scene:intro"));
    for (const key of ["", "a", "scene:a-very-long-name-indeed"]) {
      expect(Number.isInteger(seedFor(key))).toBe(true);
      expect(seedFor(key)).toBeGreaterThanOrEqual(0);
      expect(seedFor(key)).toBeLessThan(1_000_000);
    }
    expect(planMusic({ ...music, seed: 42 }, { key: "scene:intro", durationMs: 5000 }).seed).toBe(42);
  });
});

describe("syncing music to the picture", () => {
  it("fits a tempo near the style's own so that beats land on the moments", () => {
    const base = styleTempo("upbeat");
    // Moments that sit exactly on the beats of 122 beats per minute, offset by a fraction of a beat.
    const beat = 60_000 / 122;
    const moments = [3, 7, 12, 20].map((count) => count * beat - 130);
    const fit = fitTempo(base, moments);
    expect(Math.abs(fit.bpm - base) / base).toBeLessThanOrEqual(0.08 + 1e-9);
    expect(fit.errorMs).toBeLessThan(12);
    for (const moment of moments) {
      const position = (moment + fit.phaseMs) / (60_000 / fit.bpm);
      expect(Math.abs(position - Math.round(position)) * (60_000 / fit.bpm)).toBeLessThan(25);
    }
    // The same moments are far from the beat at the unfitted tempo.
    const unfitted =
      moments.reduce(
        (sum, moment) =>
          sum + Math.abs(moment / (60_000 / base) - Math.round(moment / (60_000 / base))) * (60_000 / base),
        0,
      ) / moments.length;
    expect(unfitted).toBeGreaterThan(fit.errorMs * 4);
  });

  it("keeps the style's tempo when there is nothing to fit, and lands a single moment exactly", () => {
    expect(fitTempo(118, [])).toEqual({ bpm: 118, phaseMs: 0, errorMs: 0 });
    const one = fitTempo(82, [2345]);
    expect(one.bpm).toBe(82);
    expect(one.errorMs).toBeLessThan(15);
  });

  it("plans accents and a fitted tempo only when sync is on and moments fall inside the clip", () => {
    const music = MusicSchema.parse({ style: "lofi", seed: 3 });
    const plain = planMusic(music, { key: "k", durationMs: 8000 });
    expect(plain).toEqual({ style: "lofi", seed: 3, durationMs: 8000 });
    const synced = planMusic(music, { key: "k", durationMs: 8000, momentsMs: [100, 2000, 4100, 7950] });
    expect(synced.accentsMs).toEqual([2000, 4100]); // the first and last sit in the fades
    expect(synced.accentLevel).toBe(0.6);
    expect(Math.abs(synced.bpm! - 82) / 82).toBeLessThanOrEqual(0.08 + 1e-9);
    expect(planMusic({ ...music, sync: false }, { key: "k", durationMs: 8000, momentsMs: [2000, 4100] })).toEqual(
      plain,
    );
    // A fitted render really moves the beat: it differs from the plain one and reports its tempo.
    const rendered = renderMusic(synced);
    expect(rendered.bpm).toBe(synced.bpm);
    expect(rendered.left.length).toBe(8 * 44100);
    expect(rendered.left.some((value, index) => value !== renderMusic(plain).left[index])).toBe(true);
  });

  it("puts a drum hit on each moment when a tempo in range can reach them", () => {
    // Moments on the beats of 121 beats per minute, starting off the beat: reachable from 118.
    const beat = 60_000 / 121;
    const moments = [4, 8, 13].map((count) => Math.round(count * beat - 200));
    const plan = planMusic(MusicSchema.parse({ style: "upbeat", seed: 5 }), {
      key: "k",
      durationMs: 9000,
      momentsMs: moments,
    });
    expect(fitTempo(styleTempo("upbeat"), moments).errorMs).toBeLessThan(6);
    // Accents off, so what is measured is the kick drum itself landing there.
    const music = renderMusic({ ...plan, accentLevel: 0 });
    const window = (fromMs: number, toMs: number) =>
      rms(music.left, Math.round((fromMs / 1000) * 44100), Math.round((toMs / 1000) * 44100));
    for (const moment of moments)
      expect(window(moment, moment + 50), `hit at ${moment}`).toBeGreaterThan(window(moment - 70, moment - 20) * 1.5);
  });

  it("gets as close as the tempo range allows for moments that do not share a beat, and says how close", () => {
    const moments = [1730, 3990, 6210];
    const fit = fitTempo(styleTempo("upbeat"), moments);
    expect(Math.abs(fit.bpm - 118) / 118).toBeLessThanOrEqual(0.08 + 1e-9);
    expect(fit.errorMs).toBeLessThan(45);
    // Better than leaving the tempo alone.
    const beatMs = 60_000 / 118;
    const untouched =
      moments.reduce(
        (sum, moment) =>
          sum +
          Math.min(
            Math.abs(moment / beatMs - Math.round(moment / beatMs)) * beatMs,
            Math.abs((moment / beatMs) * 2 - Math.round((moment / beatMs) * 2)) * (beatMs / 2) + 12,
          ),
        0,
      ) / moments.length;
    expect(fit.errorMs).toBeLessThan(untouched);
    // The accents are on the moments exactly, whatever the fit.
    expect(
      planMusic(MusicSchema.parse({ style: "upbeat" }), { key: "k", durationMs: 9000, momentsMs: moments }).accentsMs,
    ).toEqual(moments);
  });

  it("finds when each part of a scene arrives, ignoring camera travel", () => {
    const recipe = (name: string) => {
      const result = validateRecipe(
        JSON.parse(
          readFileSync(
            new URL(`../../examples/vite-app/src/clipmunk/scenes/${name}.scene.json`, import.meta.url),
            "utf8",
          ),
        ),
      );
      if (!result.ok) throw new Error(JSON.stringify(result.issues));
      return result.data.definition;
    };
    expect(sceneMoments(recipe("plating"))).toEqual([2600, 3000, 3400, 3800, 4200]);
    expect(sceneMoments(recipe("page-survey"))).toEqual([]); // only the camera moves
    const half = { ...recipe("plating"), motion: { ...recipe("plating").motion!, speed: 0.5 } };
    expect(sceneMoments(half)).toEqual([5200, 6000, 6800, 7600, 8400]);
    expect(sceneMoments({})).toEqual([]);
  });

  it("finds the first click of each burst in a take, on the trimmed clock", () => {
    const click = (t: number): TakeEvent => ({ t, k: "down", x: 1, y: 1, button: 0, rect: [0, 0, 1, 1] });
    const events: TakeEvent[] = [
      click(500),
      click(2000),
      click(2400),
      click(3000),
      click(6000),
      { t: 6100, k: "move", x: 1, y: 1 },
      click(9500),
    ];
    expect(takeMoments(defaultEdit(10_000).trim, events)).toEqual([500, 2000, 6000, 9500]);
    expect(takeMoments({ startMs: 1000, endMs: 7000 }, events)).toEqual([1000, 5000]);
  });
});
