import { describe, expect, it } from "vitest";
import { ratioCanvas, reframePath, type TakeEvent } from "./index";

const SOURCE = { width: 1280, height: 720 };
const click = (t: number, rect: [number, number, number, number], upAfter = 90): TakeEvent[] => [
  { t, k: "down", x: rect[0] + rect[2] / 2, y: rect[1] + rect[3] / 2, button: 0, rect },
  { t: t + upAfter, k: "up", x: rect[0] + rect[2] / 2, y: rect[1] + rect[3] / 2, button: 0 },
];
/** Every clicked box is inside the window from its press to its release. */
function assertGuarantee(events: TakeEvent[], aspect: number) {
  const path = reframePath(events, SOURCE, aspect);
  const downs = events.filter((event) => event.k === "down");
  for (const down of downs) {
    if (down.k !== "down" || down.rect[2] > path.width) continue;
    const up = events.find((event) => event.k === "up" && event.t >= down.t)!;
    for (let t = down.t; t <= up.t; t += 10) {
      const left = path.at(t);
      expect(left, `window inside the source at ${t}`).toBeGreaterThanOrEqual(-1e-6);
      expect(left + path.width).toBeLessThanOrEqual(SOURCE.width + 1e-6);
      expect(down.rect[0], `box left at ${t}`).toBeGreaterThanOrEqual(left - 1e-6);
      expect(down.rect[0] + down.rect[2], `box right at ${t}`).toBeLessThanOrEqual(left + path.width + 1e-6);
    }
  }
}

describe("reframing", () => {
  it("gives each ratio a canvas with 1080 pixels on the short side", () => {
    expect(ratioCanvas("16:9")).toEqual({ width: 1920, height: 1080 });
    expect(ratioCanvas("9:16")).toEqual({ width: 1080, height: 1920 });
    expect(ratioCanvas("1:1")).toEqual({ width: 1080, height: 1080 });
    expect(ratioCanvas("4:5")).toEqual({ width: 1080, height: 1350 });
  });

  it("crops nothing for a shape as wide as the recording or wider", () => {
    expect(reframePath(click(1000, [10, 10, 20, 20]), SOURCE, 16 / 9)).toMatchObject({ width: 1280, crops: false });
    expect(reframePath([], SOURCE, 2).at(5000)).toBe(0);
  });

  it("starts on the first click and moves to the next one before it happens", () => {
    const events = [...click(1000, [100, 300, 80, 40]), ...click(4000, [1100, 300, 80, 40])];
    const path = reframePath(events, SOURCE, 9 / 16);
    expect(path.width).toBe(405);
    expect(path.at(0)).toBe(0); // the first box is near the left edge, so the window sits against it
    expect(path.at(4000 - 300)).toBe(1280 - 405); // arrived 300 ms early, against the right edge
    expect(path.at(2000)).toBe(0); // holding until it has to leave
    const middle = path.at(4000 - 300 - 350);
    expect(middle).toBeGreaterThan(0);
    expect(middle).toBeLessThan(1280 - 405);
  });

  it("centres on a box when it can, and follows the pointer for a click on the page background", () => {
    expect(reframePath(click(500, [600, 300, 80, 40]), SOURCE, 9 / 16).at(500)).toBe(640 - 202.5);
    const background: TakeEvent[] = [{ t: 500, k: "down", x: 900, y: 200, button: 0, rect: [0, 0, 1280, 720] }];
    expect(reframePath(background, SOURCE, 9 / 16).at(500)).toBe(900 - 202.5);
  });

  it("keeps every clicked box in the window from press to release, however the clicks fall", () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let run = 0; run < 40; run++) {
      const events: TakeEvent[] = [];
      let t = random() * 500;
      for (let index = 0; index < 12; index++) {
        const width = 10 + random() * 200,
          press = 40 + random() * 400;
        events.push(...click(t, [random() * (1280 - width), random() * 680, width, 30], press));
        // One pointer: the next press comes after this release, sometimes straight after it.
        t += press + (random() < 0.3 ? 1 + random() * 150 : 200 + random() * 3000);
      }
      assertGuarantee(events, [9 / 16, 1, 4 / 5][run % 3]!);
    }
  });
});
