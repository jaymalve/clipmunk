import { describe, expect, it } from "vitest";
import { defaultEdit, summarizeTake, TakeEventSchema, takeId, validateTake } from "./index";

const source = {
  width: 1280,
  height: 720,
  dpr: 2,
  durationMs: 5000,
  background: "rgb(255, 255, 255)",
  screen: { file: "screen.webm", offsetMs: 0, latencyMs: 40, width: 2560, height: 1440 },
  events: { file: "events.jsonl", count: 12 },
};
const take = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  id: "take-20261005-142233",
  title: "Demo",
  createdAt: "2026-10-05T14:22:33.000Z",
  source,
  edit: defaultEdit(5000),
  ...overrides,
});

describe("take schema", () => {
  it("starts every take untrimmed on a 16:9 canvas with auto-zoom", () => {
    const result = validateTake(take());
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.data.edit).toMatchObject({
      trim: { startMs: 0, endMs: 5000 },
      canvas: { width: 1920, height: 1080 },
      zoom: { mode: "auto", params: { minScale: 1.25, maxScale: 2.2 } },
      cursor: { visible: true, clickEffect: "ripple" },
      cam: { shape: "circle", corner: "br" },
      audio: { muted: false, normalize: true },
    });
    expect(summarizeTake(result.data)).toEqual({
      id: "take-20261005-142233",
      title: "Demo",
      createdAt: "2026-10-05T14:22:33.000Z",
      durationMs: 5000,
      width: 2560,
      height: 1440,
      hasCam: false,
      hasAudio: false,
    });
  });
  it("rejects a trim outside the recording and unknown keys", () => {
    expect(validateTake(take({ edit: { ...defaultEdit(5000), trim: { startMs: 0, endMs: 9000 } } })).ok).toBe(false);
    expect(validateTake(take({ edit: { ...defaultEdit(5000), trim: { startMs: 3000, endMs: 3000 } } })).ok).toBe(false);
    expect(validateTake(take({ source: { ...source, secret: 1 } })).ok).toBe(false);
    expect(validateTake(take({ id: "Take 1" })).ok).toBe(false);
  });
  it("names takes so they sort by time", () => {
    expect(takeId(new Date(2026, 9, 5, 4, 7, 9))).toBe("take-20261005-040709");
  });
});

describe("take events", () => {
  it("accepts each event kind", () => {
    for (const event of [
      { t: 0, k: "resize", width: 1280, height: 720 },
      { t: 10, k: "move", x: 1.5, y: 2 },
      { t: 20, k: "down", x: 1, y: 2, button: 0, rect: [0, 0, 10, 10] },
      { t: 30, k: "up", x: 1, y: 2, button: 0 },
      { t: 40, k: "cursor", style: "pointer" },
      { t: 50, k: "scroll", x: 0, y: 300 },
      { t: 60, k: "focus", rect: [0, 0, 10, 10], editable: true },
      { t: 70, k: "type", rect: [0, 0, 10, 10] },
    ])
      expect(TakeEventSchema.safeParse(event).success, event.k).toBe(true);
  });
  it("has no field that could carry typed text", () => {
    expect(TakeEventSchema.safeParse({ t: 1, k: "type", rect: [0, 0, 1, 1], key: "a" }).success).toBe(false);
    expect(
      TakeEventSchema.safeParse({ t: 1, k: "focus", rect: [0, 0, 1, 1], editable: true, value: "hunter2" }).success,
    ).toBe(false);
    expect(TakeEventSchema.safeParse({ t: -1, k: "move", x: 0, y: 0 }).success).toBe(false);
    expect(TakeEventSchema.safeParse({ t: 1, k: "keydown" }).success).toBe(false);
  });
});
