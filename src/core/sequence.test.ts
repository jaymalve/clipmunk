import { describe, expect, it } from "vitest";
import { formatGuide, getGuide, planSequence, SceneRecipeSchema, SequenceSchema, validateSequence } from "./index";

const item = (kind: "scene" | "take", id: string, transition?: { kind: "cut" | "fade"; ms?: number }) => ({
  clip: { kind, id },
  ...(transition ? { transition } : {}),
});

describe("sequence schema", () => {
  it("fills a 1080p, 60 fps frame and cuts by default", () => {
    const result = validateSequence({
      version: 1,
      id: "launch",
      title: "Launch",
      items: [item("scene", "intro"), item("take", "demo", { kind: "fade" })],
    });
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.data).toMatchObject({ width: 1920, height: 1080, fps: 60 });
    expect(result.data.items.map((entry) => entry.transition)).toEqual([
      { kind: "cut", ms: 500 },
      { kind: "fade", ms: 500 },
    ]);
  });
  it("rejects an empty sequence, odd sizes, bad ids and audio outside .clipmunk/audio", () => {
    const base = { version: 1, id: "launch", title: "Launch", items: [item("scene", "intro")] };
    expect(validateSequence({ ...base, items: [] }).ok).toBe(false);
    expect(validateSequence({ ...base, width: 1921 }).ok).toBe(false);
    expect(validateSequence({ ...base, fps: 24 }).ok).toBe(false);
    expect(validateSequence({ ...base, items: [item("scene", "Not A Slug")] }).ok).toBe(false);
    expect(validateSequence({ ...base, audio: [{ file: "../../secrets.wav" }] }).ok).toBe(false);
    expect(validateSequence({ ...base, audio: [{ file: "music.mp3", gain: 0.4 }] }).ok).toBe(true);
    expect(
      SceneRecipeSchema.safeParse({
        version: 1,
        id: "a",
        title: "A",
        definition: { scene: { nodes: [] } },
        audio: [{ file: "/etc/passwd" }],
      }).success,
    ).toBe(false);
  });
});

describe("sequence timing", () => {
  const items = SequenceSchema.parse({
    version: 1,
    id: "s",
    title: "S",
    items: [
      item("scene", "a"),
      item("take", "b", { kind: "fade", ms: 500 }),
      item("scene", "c"),
      item("scene", "d", { kind: "fade", ms: 4000 }),
    ],
  }).items;
  it("overlaps clips by the fade and butts them together on a cut", () => {
    const plan = planSequence(items, [1500, 4000, 2000, 1000]);
    expect(plan.fadesMs).toEqual([0, 500, 0, 500]); // the last fade is capped at half of its 1 s clip
    expect(plan.startsMs).toEqual([0, 1000, 5000, 6500]);
    expect(plan.totalMs).toBe(7500);
  });
  it("ignores a transition on the first item", () => {
    const first = SequenceSchema.parse({
      version: 1,
      id: "s",
      title: "S",
      items: [item("scene", "a", { kind: "fade", ms: 800 })],
    }).items;
    expect(planSequence(first, [2000])).toEqual({ startsMs: [0], fadesMs: [0], totalMs: 2000 });
  });
});

describe("guide", () => {
  it("documents sequences with an example the schema accepts", () => {
    const guide = getGuide();
    expect(validateSequence(JSON.parse(JSON.stringify(guide.sequences.example))).ok).toBe(true);
    expect(formatGuide()).toContain("## Sequences");
    expect(Object.keys(guide.commands).some((command) => command.includes("--sequence"))).toBe(true);
  });
});
