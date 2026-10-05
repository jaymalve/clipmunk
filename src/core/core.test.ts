import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CAMERA,
  DEFAULT_FOCUS,
  DEFAULT_TRANSFORM,
  NO_MOTION,
  cinematicProgress,
  compileMotion,
  evaluateFrame,
  evaluateMotion,
  interpolate,
  matrixFor,
  motionDuration,
  multiply,
  planFocus,
  resolveFrame,
  sigmaAtDepth,
  validateDefinition,
  validateRecipe,
  validateScene,
  type Measurement,
  type Motion,
} from "./index";

const motion = (input: unknown): Motion => {
  const result = compileMotion(input);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.data;
};
const messages = (result: { ok: boolean; issues?: { message: string }[] }) => (result.ok ? [] : result.issues!.map((issue) => issue.message));

describe("scene schema", () => {
  it("fills defaults", () => {
    const result = validateScene({ nodes: [{ id: "page" }] });
    expect(result.ok && result.data.camera).toEqual(DEFAULT_CAMERA);
    expect(result.ok && result.data.nodes[0]!.transform).toEqual(DEFAULT_TRANSFORM);
  });
  it("rejects duplicate ids, missing parents and cycles", () => {
    expect(messages(validateScene({ nodes: [{ id: "a" }, { id: "a" }] }))).toContain("Duplicate surface id: a");
    expect(messages(validateScene({ nodes: [{ id: "a", parentId: "b" }] }))).toContain("Missing parent: b");
    expect(messages(validateScene({ nodes: [{ id: "a", parentId: "b" }, { id: "b", parentId: "a" }] })).some((m) => m.startsWith("Cyclic"))).toBe(true);
  });
  it("rejects a focus distance inside the focal length and unknown keys", () => {
    expect(validateScene({ focus: { distance: 40, focalLength: 50 }, nodes: [] }).ok).toBe(false);
    expect(validateScene({ nodes: [], radius: 3 }).ok).toBe(false);
  });
});

describe("motion", () => {
  const camX = (keyframes: unknown[], extra = {}) => ({ durationMs: 1000, tracks: [{ target: { kind: "camera" }, property: "x", keyframes }], ...extra });
  it("holds end values and hits keyframes exactly", () => {
    const frames = motion(camX([{ timeMs: 200, value: 10 }, { timeMs: 800, value: 50 }])).tracks[0]!.keyframes;
    expect(interpolate(frames, 0)).toBe(10);
    expect(interpolate(frames, 200)).toBe(10);
    expect(interpolate(frames, 800)).toBe(50);
    expect(interpolate(frames, 5000)).toBe(50);
    expect(interpolate(frames, 500)).toBeCloseTo(30, 10); // every easing is symmetric about its midpoint
  });
  it("eases cinematically by default with flat ends", () => {
    expect(cinematicProgress(0)).toBe(0);
    expect(cinematicProgress(1)).toBe(1);
    expect(cinematicProgress(0.001)).toBeLessThan(1e-7);
    const linear = motion(camX([{ timeMs: 0, value: 0, easing: "linear" }, { timeMs: 1000, value: 100 }]));
    expect(evaluateMotion(linear, 250).camera.x).toBeCloseTo(25, 10);
    const eased = motion(camX([{ timeMs: 0, value: 0 }, { timeMs: 1000, value: 100 }]));
    expect(evaluateMotion(eased, 250).camera.x).toBeLessThan(25);
  });
  it("maps presentation time through speed and clamps", () => {
    const half = motion(camX([{ timeMs: 0, value: 0, easing: "linear" }, { timeMs: 1000, value: 100 }], { speed: 0.5 }));
    expect(motionDuration(half)).toBe(2000);
    expect(evaluateMotion(half, 1000).camera.x).toBeCloseTo(50, 10);
    expect(evaluateMotion(half, 99999).camera.x).toBe(100);
    expect(evaluateMotion(half, -5).camera.x).toBe(0);
  });
  it("groups surface overrides by id", () => {
    const state = evaluateMotion(
      motion({ durationMs: 100, tracks: [
        { target: { kind: "surface", id: "a" }, property: "z", keyframes: [{ timeMs: 0, value: 80 }] },
        { target: { kind: "surface", id: "a" }, property: "opacity", keyframes: [{ timeMs: 0, value: 0.5 }] },
      ] }),
      0,
    );
    expect(state.surfaces.get("a")).toEqual({ z: 80, opacity: 0.5 });
  });
  it("rejects bad tracks with a reason", () => {
    expect(messages(compileMotion(camX([{ timeMs: 0, value: 0 }, { timeMs: 0, value: 1 }])))).toContain("Keyframe times must be strictly increasing.");
    expect(messages(compileMotion(camX([{ timeMs: 2000, value: 0 }])))).toContain("Keyframe time exceeds the scene duration.");
    expect(compileMotion({ durationMs: 10, tracks: [{ target: { kind: "camera" }, property: "perspective", keyframes: [{ timeMs: 0, value: 900 }] }] }).ok).toBe(false);
    expect(compileMotion({ durationMs: 10, tracks: [{ target: { kind: "surface", id: "a" }, property: "opacity", keyframes: [{ timeMs: 0, value: 2 }] }] }).ok).toBe(false);
    const twice = { target: { kind: "camera" }, property: "x", keyframes: [{ timeMs: 0, value: 0 }] };
    expect(messages(compileMotion({ durationMs: 10, tracks: [twice, twice] }))).toContain("Duplicate track for the same target and property.");
  });
});

describe("spatial", () => {
  const size = (width = 1000, height = 600, offsetX = 0, offsetY = 0): Measurement => ({ width, height, offsetX, offsetY });
  const frameOf = (nodes: Parameters<typeof resolveFrame>[2], camera = {}, focus = {}) =>
    resolveFrame({ ...DEFAULT_CAMERA, ...camera }, { ...DEFAULT_FOCUS, ...focus }, nodes, NO_MOTION);

  it("composes translate, rotate, scale in CSS order", () => {
    const identity = matrixFor(DEFAULT_TRANSFORM);
    expect(multiply(identity, identity)).toEqual(identity);
    // rotateY(90deg) sends local +x to world -z.
    const turned = matrixFor({ ...DEFAULT_TRANSFORM, rotateY: 90 });
    expect(turned[8]).toBeCloseTo(-1, 10);
    const moved = matrixFor({ ...DEFAULT_TRANSFORM, x: 5, y: 6, z: 7, scale: 2 });
    expect([moved[3], moved[7], moved[11], moved[0]]).toEqual([5, 6, 7, 2]);
  });
  it("measures depth from the projection plane", () => {
    const flat = evaluateFrame(frameOf([{ id: "a", transform: { ...DEFAULT_TRANSFORM, z: 100 } }]), new Map([["a", size()]]));
    expect(flat.nodes[0]!.depth).toBe(1300);
    const pulledBack = evaluateFrame(frameOf([{ id: "a" }], { z: 100 }), new Map([["a", size()]]));
    expect(pulledBack.nodes[0]!.depth).toBe(1500);
  });
  it("carries children with their parent, including layout offsets", () => {
    const frame = frameOf([
      { id: "p", transform: { ...DEFAULT_TRANSFORM, rotateY: 90 } },
      { id: "c", parentId: "p" },
    ]);
    const result = evaluateFrame(frame, new Map([["p", size()], ["c", size(100, 100, 200, 0)]]));
    // The child sits 200px along the parent's local x, which now points away from the viewer.
    expect(result.nodes[1]!.depth).toBeCloseTo(1600, 6);
  });
  it("reports surfaces at the camera plane", () => {
    const result = evaluateFrame(frameOf([{ id: "a", transform: { ...DEFAULT_TRANSFORM, z: 1400 } }]), new Map([["a", size()]]));
    expect(result.issues.map((issue) => issue.code)).toContain("behind-camera");
  });
});

describe("focus", () => {
  const field = (depth: number, depthX = 0, focus = {}) => ({ ...DEFAULT_FOCUS, ...focus, depth, depthX, depthY: 0, scale: 1 });
  it("is sharp at the focus distance and grows linearly to the cap", () => {
    expect(sigmaAtDepth(DEFAULT_FOCUS, 1400)).toBe(0);
    const near = sigmaAtDepth(DEFAULT_FOCUS, 1300), nearer = sigmaAtDepth(DEFAULT_FOCUS, 1200);
    expect(nearer).toBeCloseTo(near * 2, 10);
    expect(sigmaAtDepth({ ...DEFAULT_FOCUS, fStop: 0.7 }, 100000)).toBe(DEFAULT_FOCUS.maxBlur);
  });
  it("skips the filter for in-focus flat surfaces and when blur is disabled", () => {
    expect(planFocus(field(1400), 1000, 600)).toEqual({ kind: "none" });
    expect(planFocus(field(900, 0.4, { maxBlur: 0 }), 1000, 600)).toEqual({ kind: "none" });
  });
  it("uses one uniform blur for a flat out-of-focus surface", () => {
    const plan = planFocus(field(400, 0, { fStop: 1 }), 1000, 600);
    expect(plan.kind).toBe("uniform");
    expect(plan.kind === "uniform" && plan.blurPx).toBeCloseTo(sigmaAtDepth({ ...DEFAULT_FOCUS, fStop: 1 }, 400), 10);
  });
  it("blends bands whose weights sum to one across a tilted surface", () => {
    const plan = planFocus(field(1400, 0.45, { fStop: 1.4 }), 1400, 980, 6);
    if (plan.kind !== "varying") throw new Error("expected a varying plan");
    expect(plan.mask.bands.length).toBeGreaterThan(2);
    expect(plan.mask.bands.length).toBeLessThanOrEqual(7);
    expect(plan.mask.xWeight + plan.mask.yWeight).toBeCloseTo(1, 10);
    for (let sample = 0; sample < plan.mask.bands[0]!.weights.length; sample++)
      expect(plan.mask.bands.reduce((sum, band) => sum + band.weights[sample]!, 0)).toBeCloseTo(1, 10);
    const preview = planFocus(field(1400, 0.45, { fStop: 1.4 }), 1400, 980, 3);
    expect(preview.kind === "varying" && preview.mask.bands.length).toBeLessThanOrEqual(4);
  });
});

describe("recipes", () => {
  it("rejects motion that targets a surface the scene does not declare", () => {
    const result = validateDefinition({
      scene: { nodes: [{ id: "page" }] },
      motion: { durationMs: 10, tracks: [{ target: { kind: "surface", id: "ghost" }, property: "z", keyframes: [{ timeMs: 0, value: 1 }] }] },
    });
    expect(messages(result)).toContain("Motion targets an unknown surface: ghost");
  });
  it("accepts every recipe in the example app", () => {
    const directory = new URL("../../examples/vite-app/src/flick/scenes/", import.meta.url);
    const files = readdirSync(directory).filter((file) => file.endsWith(".scene.json"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const result = validateRecipe(JSON.parse(readFileSync(new URL(file, directory), "utf8")));
      expect(messages(result), file).toEqual([]);
      expect(result.ok && `${result.data.id}.scene.json`).toBe(file);
    }
  });
});
