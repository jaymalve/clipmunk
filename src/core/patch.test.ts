import { describe, expect, it } from "vitest";
import { diffJson, formatChanges, mergePatch } from "./index";

describe("merge patches", () => {
  it("merges objects, replaces arrays and values, and removes keys set to null", () => {
    const target = { trim: { startMs: 0, endMs: 4000 }, items: [1, 2], music: { style: "lofi" }, keep: true };
    expect(mergePatch(target, { trim: { startMs: 500 }, items: [3], music: null })).toEqual({
      trim: { startMs: 500, endMs: 4000 },
      items: [3],
      keep: true,
    });
    expect(target.trim.startMs).toBe(0); // the target is not changed
  });

  it("replaces an object that switches its mode", () => {
    const zoom = { mode: "auto", params: { maxScale: 2 } };
    expect(mergePatch({ zoom }, { zoom: { mode: "off" } })).toEqual({ zoom: { mode: "off" } });
    expect(mergePatch({ zoom }, { zoom: { params: { maxScale: 3 } } })).toEqual({
      zoom: { mode: "auto", params: { maxScale: 3 } },
    });
  });

  it("describes what changed", () => {
    const changes = diffJson({ a: { b: 1, c: [1] }, d: 1 }, { a: { b: 2, c: [1] }, e: 2 });
    expect(changes).toEqual([
      { path: "a.b", before: 1, after: 2 },
      { path: "d", before: 1 },
      { path: "e", after: 2 },
    ]);
    expect(formatChanges(changes)).toBe("a.b: 1 -> 2\nd: 1 -> null\ne: null -> 2");
    expect(formatChanges([])).toBe("No change.");
  });
});
