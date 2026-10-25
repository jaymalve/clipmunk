import { describe, expect, it } from "vitest";
import { REDACT_GUARD_MS, REDACT_MARGIN, type RedactEntry, redactionTrack, type TakeEvent } from "./index";

const m = REDACT_MARGIN;
const grown = ([x, y, w, h]: number[]) => [x! - m, y! - m, w! + 2 * m, h! + 2 * m];
const rects = (track: ReturnType<typeof redactionTrack>, t: number) => track.at(t).map((box) => box.rect);

// A box that sits still, scrolls up by 100 px over 300 ms, then sits still again.
const events: TakeEvent[] = [
  { t: 0, k: "resize", width: 640, height: 360 },
  { t: 16, k: "redact", sel: ".secret", rects: [[100, 200, 80, 20]] },
  { t: 1000, k: "redact", sel: ".secret", rects: [[100, 150, 80, 20]] },
  { t: 1300, k: "redact", sel: ".secret", rects: [[100, 100, 80, 20]] },
  { t: 2000, k: "redact", sel: ".secret", rects: [] },
  { t: 40, k: "redact", sel: ".other", rects: [[0, 0, 10, 10]] },
];
const secret: RedactEntry[] = [{ sel: ".secret", mode: "blur" }];

describe("redaction track", () => {
  it("holds each selector's last boxes until the next change, grown by the margin", () => {
    const track = redactionTrack(events, secret);
    expect(rects(track, 500)).toEqual([grown([100, 200, 80, 20])]);
    expect(rects(track, 1700)).toEqual([grown([100, 100, 80, 20])]);
    expect(track.at(500)[0]!.mode).toBe("blur");
  });

  it("covers the old and the new box around every change, and from before the first", () => {
    const track = redactionTrack(events, secret);
    expect(rects(track, 0)).toEqual([grown([100, 200, 80, 20])]);
    expect(rects(track, 1000 - REDACT_GUARD_MS)).toEqual([grown([100, 200, 80, 20]), grown([100, 150, 80, 20])]);
    expect(rects(track, 1000 + REDACT_GUARD_MS - 1)).toEqual([grown([100, 200, 80, 20]), grown([100, 150, 80, 20])]);
    // Once the old box is out of the window, the next change is already in it.
    expect(rects(track, 1000 + REDACT_GUARD_MS)).toEqual([grown([100, 150, 80, 20]), grown([100, 100, 80, 20])]);
    expect(rects(track, 1300 + REDACT_GUARD_MS)).toEqual([grown([100, 100, 80, 20])]);
  });

  it("stops when the element is gone, and covers nothing for selectors not in the edit", () => {
    const track = redactionTrack(events, secret);
    expect(rects(track, 2000 + REDACT_GUARD_MS + 1)).toEqual([]);
    expect(redactionTrack(events, [{ sel: ".missing", mode: "blur" }]).empty).toBe(true);
    expect(redactionTrack(events, []).empty).toBe(true);
    expect(track.empty).toBe(false);
  });

  it("shows hand-drawn boxes for their stretch of time, exactly as drawn", () => {
    const track = redactionTrack([], [{ rect: [10, 20, 30, 40], fromMs: 1000, toMs: 2000, mode: "block" }]);
    expect(track.empty).toBe(false);
    expect(track.at(999)).toEqual([]);
    expect(track.at(1000)).toEqual([{ rect: [10, 20, 30, 40], mode: "block" }]);
    expect(track.at(2000)).toEqual([]);
  });

  it("gives each selector its own mode", () => {
    const track = redactionTrack(events, [
      { sel: ".secret", mode: "blur" },
      { sel: ".other", mode: "block" },
    ]);
    expect(track.at(500).map((box) => box.mode)).toEqual(["blur", "block"]);
  });
});
