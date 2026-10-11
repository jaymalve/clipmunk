import type { MotionState } from "./motion";
import type { Issue } from "./result";
import { type Camera, DEFAULT_TRANSFORM, type Focus, type Transform } from "./scene";

/** Camera-space transforms and depth of field for every renderer.
 * CSS performs the real projection; this module reproduces the same transform order
 * so it can tell each surface how far each of its points is from the camera.
 * No DOM here: the React adapter supplies untransformed layout measurements.
 */
export type Matrix = readonly number[]; // 4x4, row-major
export type Measurement = { width: number; height: number; offsetX: number; offsetY: number };
export type FrameNode = { id: string; parentId?: string; transform: Transform };
export type Frame = { camera: Camera; focus: Focus; nodes: FrameNode[] };

const IDENTITY: Matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function multiply(a: Matrix, b: Matrix): Matrix {
  const out = new Array<number>(16);
  for (let row = 0; row < 4; row++)
    for (let col = 0; col < 4; col++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[row * 4 + k]! * b[k * 4 + col]!;
      out[row * 4 + col] = sum;
    }
  return out;
}

/** translate · rotateX · rotateY · rotateZ · scale, the same order transformToCss emits. */
export function matrixFor(t: Transform): Matrix {
  const rad = Math.PI / 180;
  const sx = Math.sin(t.rotateX * rad),
    cx = Math.cos(t.rotateX * rad);
  const sy = Math.sin(t.rotateY * rad),
    cy = Math.cos(t.rotateY * rad);
  const sz = Math.sin(t.rotateZ * rad),
    cz = Math.cos(t.rotateZ * rad);
  const translate: Matrix = [1, 0, 0, t.x, 0, 1, 0, t.y, 0, 0, 1, t.z, 0, 0, 0, 1];
  const rx: Matrix = [1, 0, 0, 0, 0, cx, -sx, 0, 0, sx, cx, 0, 0, 0, 0, 1];
  const ry: Matrix = [cy, 0, sy, 0, 0, 1, 0, 0, -sy, 0, cy, 0, 0, 0, 0, 1];
  const rz: Matrix = [cz, -sz, 0, 0, sz, cz, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const scale: Matrix = [t.scale, 0, 0, 0, 0, t.scale, 0, 0, 0, 0, t.scale, 0, 0, 0, 0, 1];
  return [rx, ry, rz, scale].reduce(multiply, translate);
}

export function transformToCss(t: Transform): string {
  return `translate3d(${t.x}px, ${t.y}px, ${t.z}px) rotateX(${t.rotateX}deg) rotateY(${t.rotateY}deg) rotateZ(${t.rotateZ}deg) scale(${t.scale})`;
}

const cameraTransform = (c: Camera): Transform => ({
  x: -c.x,
  y: -c.y,
  z: -c.z,
  rotateX: c.rotateX,
  rotateY: c.rotateY,
  rotateZ: c.rotateZ,
  scale: 1,
});
export const cameraToCss = (c: Camera): string => transformToCss(cameraTransform(c));

/** Apply one frame of motion overrides to the static scene values. */
export function resolveFrame(
  camera: Camera,
  focus: Focus,
  nodes: readonly { id: string; parentId?: string; transform?: Transform }[],
  motion: MotionState,
): Frame {
  return {
    camera: { ...camera, ...motion.camera },
    focus: { ...focus, ...motion.focus },
    nodes: nodes.map((node) => {
      const { opacity: _opacity, ...override } = motion.surfaces.get(node.id) ?? {};
      return {
        id: node.id,
        parentId: node.parentId,
        transform: { ...(node.transform ?? DEFAULT_TRANSFORM), ...override },
      };
    }),
  };
}

/** Depth of a surface as a linear function of position on its own plane.
 * The projection plane sits at +perspective, so a point with camera-space z has
 * depth = perspective - z. (x, y) are local pixels measured from the surface centre.
 */
export type FocusField = Focus & {
  depth: number; // at the surface centre
  depthX: number; // change per local pixel along x
  depthY: number; // change per local pixel along y
  scale: number; // world length of one local pixel
};

export function focusForSurface(world: Matrix, focus: Focus, perspective: number): FocusField {
  return {
    ...focus,
    depth: perspective - world[11]!,
    depthX: -world[8]!,
    depthY: -world[9]!,
    scale: Math.hypot(world[0]!, world[4]!, world[8]!),
  };
}

/** Gaussian sigma, in world pixels on the surface plane, for a point at a given depth.
 * Thin-lens circle of confusion with sigma = diameter / 4, which matches the variance
 * of a circular aperture. CSS perspective magnifies it afterwards, exactly once.
 */
export function sigmaAtDepth(f: Focus, depth: number): number {
  if (f.maxBlur === 0) return 0;
  if (depth <= 0 || f.distance <= f.focalLength) return f.maxBlur;
  const sigma = (f.focalLength / (4 * f.fStop * (f.distance - f.focalLength))) * Math.abs(depth - f.distance);
  return Math.min(f.maxBlur, sigma);
}
export const sampleFocus = (f: FocusField, x: number, y: number): number =>
  sigmaAtDepth(f, f.depth + f.depthX * x + f.depthY * y);

function depthBounds(f: FocusField, width: number, height: number) {
  // Blur spreads paint past the box, so the depth range covers that padding too.
  const pad = (3 * f.maxBlur) / f.scale;
  const extent = Math.abs(f.depthX) * (width / 2 + pad) + Math.abs(f.depthY) * (height / 2 + pad);
  return { min: f.depth - extent, max: f.depth + extent, pad };
}

/** How a visual leaf should be blurred: not at all, uniformly, or with a depth-varying filter. */
export type FocusPlan = { kind: "none" } | { kind: "uniform"; blurPx: number } | { kind: "varying"; mask: FocusMask };

export type FocusMask = {
  pad: number; // local pixels of filter region outside the box
  xWeight: number; // share of the depth range explained by x
  yWeight: number; // share explained by y
  reverseX: boolean;
  reverseY: boolean;
  bands: { stdDeviation: number; weights: number[] }[]; // local-pixel sigma and weight per depth sample
};

export const FULL_FOCUS_BANDS = 6;
export const PREVIEW_FOCUS_BANDS = 3;
const MASK_SAMPLES = 33;

/** `bandCount` blur levels are blended with hat-function weights that sum to one, so a
 * tilted plane gets a continuous sharp-to-soft gradient from a handful of Gaussian passes.
 */
export function planFocus(f: FocusField, width: number, height: number, bandCount = FULL_FOCUS_BANDS): FocusPlan {
  if (f.maxBlur === 0 || width <= 0 || height <= 0) return { kind: "none" };
  const { min, max, pad } = depthBounds(f, width, height);
  const low = sigmaAtDepth(f, min),
    high = sigmaAtDepth(f, max);
  // The focal plane lies outside the surface when both ends are on the same side of it.
  const sameSide = max <= f.distance || min >= f.distance;
  const flat = max - min < 1e-6;
  if (flat || (sameSide && Math.abs(low - high) < 0.05)) {
    const blurPx = (flat ? sigmaAtDepth(f, f.depth) : (low + high) / 2) / f.scale;
    return blurPx < 0.05 ? { kind: "none" } : { kind: "uniform", blurPx };
  }
  if (!sameSide && Math.max(low, high) < 0.05) return { kind: "none" };
  const span = max - min;
  const bands: FocusMask["bands"] = [];
  for (let band = 0; band <= bandCount; band++) {
    const weights = Array.from({ length: MASK_SAMPLES }, (_, i) => {
      const level = (sigmaAtDepth(f, min + (span * i) / (MASK_SAMPLES - 1)) / f.maxBlur) * bandCount;
      return Math.max(0, 1 - Math.abs(level - band));
    });
    // A band that never contributes costs a Gaussian pass for nothing.
    if (weights.some((weight) => weight > 0))
      bands.push({ stdDeviation: (f.maxBlur * band) / bandCount / f.scale, weights });
  }
  return {
    kind: "varying",
    mask: {
      pad,
      xWeight: (Math.abs(f.depthX) * (width + 2 * pad)) / span,
      yWeight: (Math.abs(f.depthY) * (height + 2 * pad)) / span,
      reverseX: f.depthX < 0,
      reverseY: f.depthY < 0,
      bands,
    },
  };
}

export type EvaluatedNode = {
  id: string;
  world: Matrix;
  depth: number;
  focus: FocusField;
  width: number;
  height: number;
};
export type Evaluation = { nodes: EvaluatedNode[]; issues: Issue[] };

/** World matrices and focus fields for one frame. Nodes must already form a valid tree. */
export function evaluateFrame(frame: Frame, measurements: ReadonlyMap<string, Measurement>): Evaluation {
  const issues: Issue[] = [];
  const byId = new Map(frame.nodes.map((node) => [node.id, node]));
  const camera = matrixFor(cameraTransform(frame.camera));
  const cache = new Map<string, Matrix>();
  const worldOf = (id: string, guard = 0): Matrix => {
    const cached = cache.get(id);
    if (cached) return cached;
    const node = byId.get(id);
    if (!node || guard > frame.nodes.length) return IDENTITY;
    const m = measurements.get(id);
    // A surface starts where CSS laid it out: its centre offset from its parent's centre.
    const local = matrixFor({
      ...node.transform,
      x: node.transform.x + (m?.offsetX ?? 0),
      y: node.transform.y + (m?.offsetY ?? 0),
    });
    const world = multiply(node.parentId ? worldOf(node.parentId, guard + 1) : camera, local);
    cache.set(id, world);
    return world;
  };
  const nodes: EvaluatedNode[] = [];
  for (const node of frame.nodes) {
    const world = worldOf(node.id);
    if (!world.every(Number.isFinite)) {
      issues.push({
        code: "invalid-geometry",
        path: node.id,
        message: `Transform of ${node.id} exceeds numeric limits: reduce nested scale or position.`,
      });
      continue;
    }
    const m = measurements.get(node.id);
    if (m && (m.width <= 0 || m.height <= 0))
      issues.push({ code: "empty-surface", path: node.id, message: `Surface ${node.id} has no measurable area.` });
    const focus = focusForSurface(world, frame.focus, frame.camera.perspective);
    if (focus.depth <= 1)
      issues.push({
        code: "behind-camera",
        path: node.id,
        message: `Surface ${node.id} reaches the camera plane: move it farther back.`,
      });
    nodes.push({ id: node.id, world, depth: focus.depth, focus, width: m?.width ?? 0, height: m?.height ?? 0 });
  }
  return { nodes, issues };
}
