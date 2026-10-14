import { describe, expect, it } from "vitest";
import { renderSounds, SceneRecipeSchema, type Sound, SoundSchema, typingKeys } from "./index";

const typing = (input: Partial<Sound> = {}): Sound =>
  SoundSchema.parse({ kind: "typing", atMs: 400, chars: 20, ...input });
const rms = (samples: Float32Array, from: number, to: number) => {
  let sum = 0;
  for (let i = from; i < to; i++) sum += samples[i]! ** 2;
  return Math.sqrt(sum / Math.max(1, to - from));
};

describe("typing sounds", () => {
  it("fills in a natural typing speed and no Return key by default", () => {
    expect(typing()).toEqual({ kind: "typing", atMs: 400, chars: 20, perSecond: 12, enter: false, gain: 1 });
    expect(SoundSchema.safeParse({ kind: "typing", atMs: 0 }).success).toBe(false);
    expect(SoundSchema.safeParse({ kind: "beep", atMs: 0, chars: 1 }).success).toBe(false);
  });

  it("is accepted in a scene recipe", () => {
    const recipe = { version: 1, id: "a", title: "A", definition: { scene: { nodes: [] } } };
    expect(SceneRecipeSchema.safeParse({ ...recipe, sounds: [{ kind: "typing", atMs: 0, chars: 5 }] }).success).toBe(
      true,
    );
    expect(SceneRecipeSchema.safeParse({ ...recipe, sounds: [{ kind: "typing", atMs: -1, chars: 5 }] }).success).toBe(
      false,
    );
  });

  it("clicks once per character at a real typing speed, from the moment typing starts", () => {
    const keys = typingKeys(typing({ perSecond: 10 }));
    expect(keys).toHaveLength(20);
    expect(keys[0]!.at).toBeCloseTo(0.4, 1);
    expect(keys.at(-1)!.at).toBeCloseTo(0.4 + 19 * 0.1, 1);
  });

  it("thins fast on-screen typing so it sounds like typing, not a buzz", () => {
    const keys = typingKeys(typing({ chars: 46, perSecond: 46 }));
    expect(keys.length).toBeLessThan(20);
    expect(keys.length).toBeGreaterThan(12);
    for (let i = 1; i < keys.length; i++) expect(keys[i]!.at - keys[i - 1]!.at).toBeGreaterThan(0.045);
  });

  it("presses Return after the last character when asked, and follows the scene's speed", () => {
    const keys = typingKeys(typing({ chars: 10, perSecond: 10, enter: true }));
    expect(keys).toHaveLength(11);
    expect(keys.at(-1)!).toMatchObject({ heavy: true });
    expect(keys.at(-1)!.at).toBeGreaterThan(0.4 + 1.0);
    expect(typingKeys(typing({ atMs: 1000 }), 2)[0]!.at).toBeCloseTo(0.5, 1);
  });

  it("is heard only while typing, never clips, and renders the same every time", () => {
    const request = { sounds: [typing({ perSecond: 10 })], durationMs: 4000, seed: 3 };
    const sound = renderSounds(request);
    expect(sound.left.length).toBe(4 * 44100);
    const during = rms(sound.left, Math.round(0.5 * 44100), Math.round(2.2 * 44100));
    expect(during).toBeGreaterThan(0.01);
    expect(rms(sound.left, 0, Math.round(0.38 * 44100))).toBe(0);
    expect(rms(sound.left, Math.round(3 * 44100), sound.left.length)).toBe(0);
    expect(sound.left.every((value) => Math.abs(value) < 1)).toBe(true);
    expect(renderSounds(request).left).toEqual(sound.left);
  });
});
