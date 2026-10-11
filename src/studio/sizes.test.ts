import { describe, expect, it } from "vitest";
import { sizesFor } from "./daemon";

describe("export resolutions", () => {
  const labels = (frame: { width: number; height: number }) =>
    sizesFor(frame).map((size) => `${size.label} ${size.width}x${size.height}`);
  it("scales a landscape frame by its short side", () => {
    expect(labels({ width: 1920, height: 1080 })).toEqual([
      "Original 1920x1080",
      "720p 1280x720",
      "1440p 2560x1440",
      "4K 3840x2160",
    ]);
  });
  it("keeps portrait and square shapes, and an unusual authored frame", () => {
    expect(labels({ width: 1080, height: 1920 })).toEqual([
      "Original 1080x1920",
      "720p 720x1280",
      "1440p 1440x2560",
      "4K 2160x3840",
    ]);
    expect(labels({ width: 1080, height: 1080 }).at(-1)).toBe("4K 2160x2160");
    expect(labels({ width: 1400, height: 980 })).toEqual([
      "Original 1400x980",
      "720p 1028x720",
      "1080p 1542x1080",
      "1440p 2058x1440",
      "4K 3086x2160",
    ]);
  });
  it("never exceeds 3840 on the long side, and only offers even sizes", () => {
    const wide = sizesFor({ width: 2400, height: 1000 });
    expect(wide.at(-1)).toMatchObject({ width: 3840, height: 1600 });
    for (const size of [...wide, ...sizesFor({ width: 1401, height: 981 })])
      expect([size.width % 2, size.height % 2]).toEqual([0, 0]);
  });
});
