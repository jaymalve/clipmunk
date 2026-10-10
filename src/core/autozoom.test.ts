import { describe, expect, it } from "vitest";
import { AutoZoomParamsSchema, TakeEditSchema, TakeEventSchema, clampView, generateZoomTracks, parseEvents, prepareCursor, resolveZoomTracks, zoomAt, zoomSegments, type TakeEvent } from "./index";

const source = { width: 1280, height: 720, durationMs: 20_000 };
const params = AutoZoomParamsSchema.parse({});
const click = (t: number, x: number, y: number, rect: [number, number, number, number] = [x - 50, y - 20, 100, 40]): TakeEvent[] => [
  { t, k: "down", x, y, button: 0, rect },
  { t: t + 80, k: "up", x, y, button: 0 },
];

describe("auto-zoom", () => {
  it("does nothing without activity: moving and scrolling are not reasons to zoom", () => {
    expect(generateZoomTracks([{ t: 100, k: "move", x: 5, y: 5 }, { t: 200, k: "scroll", x: 0, y: 400 }], source, params)).toEqual([]);
  });

  it("eases in before a click, holds on it, and eases back out", () => {
    const tracks = generateZoomTracks(click(5000, 1000, 500), source, params);
    expect(tracks.map((track) => track.property)).toEqual(["x", "y", "scale"]);
    expect(zoomAt(tracks, 0, source)).toEqual({ x: 640, y: 360, scale: 1 });
    expect(zoomAt(tracks, 5000 - params.leadMs - params.easeMs, source).scale).toBe(1);
    const held = zoomAt(tracks, 5000, source);
    expect(held.scale).toBe(params.maxScale); // a button is small, so the zoom is capped
    // Already arrived when the click happens, and still there until the hold ends.
    expect(zoomAt(tracks, 5000 - params.leadMs, source)).toEqual(held);
    expect(zoomAt(tracks, 5000 + params.holdMs, source)).toEqual(held);
    expect(zoomAt(tracks, 5000 + params.holdMs + params.easeMs, source)).toEqual({ x: 640, y: 360, scale: 1 });
    expect(zoomSegments(tracks)).toEqual([{ startMs: 4000, endMs: 7200, scale: params.maxScale }]);
  });

  it("never shows anything outside the recording, at any moment", () => {
    const tracks = generateZoomTracks([...click(3000, 1270, 710), ...click(9000, 4, 6)], source, params);
    for (let t = 0; t <= source.durationMs; t += 50) {
      const view = zoomAt(tracks, t, source);
      expect(view.x - source.width / view.scale / 2).toBeGreaterThanOrEqual(-1e-6);
      expect(view.x + source.width / view.scale / 2).toBeLessThanOrEqual(source.width + 1e-6);
      expect(view.y - source.height / view.scale / 2).toBeGreaterThanOrEqual(-1e-6);
      expect(view.y + source.height / view.scale / 2).toBeLessThanOrEqual(source.height + 1e-6);
    }
    expect(clampView({ x: -50, y: 9999, scale: 2 }, source)).toEqual({ x: 320, y: 540, scale: 2 });
    expect(clampView({ x: 10, y: 10, scale: 0.5 }, source)).toEqual({ x: 640, y: 360, scale: 1 });
  });

  it("merges nearby activity into one segment and pans only when the action leaves the safe area", () => {
    const near = generateZoomTracks([...click(3000, 400, 300), ...click(4000, 430, 320)], source, params);
    expect(zoomSegments(near)).toHaveLength(1);
    expect(zoomAt(near, 3000, source)).toEqual(zoomAt(near, 4000, source)); // close by: the view stays put
    const far = generateZoomTracks([...click(3000, 200, 200), ...click(4500, 1100, 600)], source, params);
    expect(zoomSegments(far)).toHaveLength(1);
    expect(zoomAt(far, 4500, source).x).toBeGreaterThan(zoomAt(far, 3000, source).x + 300);
    expect(zoomAt(far, 3600, source).scale).toBe(params.maxScale); // it pans while staying zoomed in
    const apart = generateZoomTracks([...click(3000, 200, 200), ...click(12_000, 1100, 600)], source, params);
    expect(zoomSegments(apart)).toHaveLength(2);
    expect(zoomAt(apart, 8000, source).scale).toBe(1);
  });

  it("zooms less for large targets, aims at the pointer for background clicks, and follows typing", () => {
    const wide = generateZoomTracks(click(5000, 640, 360, [140, 160, 1000, 400]), source, params);
    expect(zoomAt(wide, 5000, source).scale).toBe(params.minScale);
    const background = generateZoomTracks(click(5000, 900, 200, [0, 0, 1280, 720]), source, params);
    expect(zoomAt(background, 5000, source).x).toBeGreaterThan(640);
    const typing = generateZoomTracks([{ t: 5000, k: "type", rect: [800, 500, 300, 40] }, { t: 5200, k: "type", rect: [800, 500, 300, 40] }], source, params);
    expect(zoomAt(typing, 5100, source).scale).toBeGreaterThan(1);
  });

  it("is deterministic and produces tracks the edit schema accepts as manual", () => {
    const events = [...click(2000, 300, 300), ...click(2600, 900, 500), ...click(15_000, 100, 650)];
    const tracks = generateZoomTracks(events, source, params);
    expect(generateZoomTracks(events, source, params)).toEqual(tracks);
    for (const track of tracks) for (const [index, frame] of track.keyframes.entries()) if (index) expect(frame.timeMs).toBeGreaterThan(track.keyframes[index - 1]!.timeMs);
    const manual = TakeEditSchema.safeParse({ trim: { startMs: 0, endMs: 20_000 }, zoom: { mode: "manual", tracks } });
    expect(manual.success).toBe(true);
    expect(resolveZoomTracks({ zoom: { mode: "off" } }, events, source)).toEqual([]);
    expect(resolveZoomTracks({ zoom: { mode: "auto", params } }, events, source)).toEqual(tracks);
    expect(manual.success && resolveZoomTracks(manual.data, [], source)).toEqual(tracks);
    // A click in the first instant cannot ease in from before time zero.
    const early = generateZoomTracks(click(100, 300, 300), source, params);
    expect(early[2]!.keyframes[0]).toMatchObject({ timeMs: 0 });
    expect(zoomAt(early, 100, source).scale).toBeGreaterThan(1);
  });
});

describe("cursor", () => {
  const wiggle: TakeEvent[] = Array.from({ length: 60 }, (_, i) => ({ t: 1000 + i * 16, k: "move" as const, x: 100 + i * 10 + (i % 2 ? 6 : -6), y: 300 + (i % 2 ? -6 : 6) }));

  it("is hidden until the pointer first moves and holds its last position afterwards", () => {
    const path = prepareCursor(wiggle, 0.6);
    expect(path.at(500).visible).toBe(false);
    expect(path.at(1500).visible).toBe(true);
    expect(path.at(99_999)).toEqual(path.at(5000));
    expect(path.at(99_999).x).toBeCloseTo(100 + 59 * 10 + 6, 0); // settles on the last logged position
    expect(prepareCursor([], 0.6).at(10).visible).toBe(false);
  });

  it("smooths jitter without lagging behind the real pointer", () => {
    const raw = prepareCursor(wiggle, 0), smooth = prepareCursor(wiggle, 1);
    const roughness = (path: ReturnType<typeof prepareCursor>) => {
      let sum = 0;
      for (let t = 1100; t < 1800; t += 8) sum += Math.abs(path.at(t).y - 300);
      return sum;
    };
    expect(roughness(smooth)).toBeLessThan(roughness(raw) / 3);
    // Zero phase: halfway through the motion the smoothed cursor is where the pointer was, not behind it.
    expect(Math.abs(smooth.at(1480).x - (100 + 30 * 10))).toBeLessThan(12);
  });

  it("passes exactly through every click and reports press state and shape", () => {
    const events: TakeEvent[] = [
      ...wiggle,
      { t: 2000, k: "cursor", style: "pointer" },
      { t: 2100, k: "move", x: 900, y: 80 },
      { t: 2200, k: "down", x: 905, y: 84, button: 0, rect: [880, 70, 60, 30] },
      { t: 2290, k: "up", x: 905, y: 84, button: 0 },
      { t: 2600, k: "move", x: 300, y: 600 },
      { t: 2700, k: "cursor", style: "text" },
    ];
    const path = prepareCursor(events, 1);
    expect(path.at(2200)).toMatchObject({ style: "pointer", pressed: true });
    expect(path.at(2200).x).toBeCloseTo(905, 6);
    expect(path.at(2200).y).toBeCloseTo(84, 6);
    expect(path.at(2400).pressed).toBe(false);
    expect(path.at(1900).style).toBe("default");
    expect(path.at(2800).style).toBe("text");
    expect(path.clicks).toEqual([{ t: 2200, x: 905, y: 84 }]);
    expect(path.lastMoveBefore(2500)).toBe(2290);
  });

  it("reads an event log, skipping damaged lines", () => {
    const text = `{"t":0,"k":"resize","width":10,"height":10}\nnot json\n{"t":5,"k":"type","rect":[0,0,1,1],"key":"x"}\n\n{"t":9,"k":"move","x":1,"y":2}\n`;
    expect(parseEvents(text, TakeEventSchema).map((event) => event.k)).toEqual(["resize", "move"]);
  });
});
