import { z } from "zod";
import { fail, ok, type Result, zodIssues } from "./result";

/** Scene geometry: a camera, a focus plane and a tree of surfaces.
 * Units are pixels and degrees. +x is right, +y is down, +z is toward the viewer.
 * spatial.ts evaluates this; the React adapter binds live elements to node ids.
 */
export const SCENE_BACKGROUND = "#000000";

const finite = z.number().finite();
export const NodeIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/, "Use a stable alphanumeric id.");

export const TransformSchema = z.strictObject({
  x: finite.default(0),
  y: finite.default(0),
  z: finite.default(0),
  rotateX: finite.default(0),
  rotateY: finite.default(0),
  rotateZ: finite.default(0),
  scale: finite.positive().max(100).default(1),
});
export const NodeSchema = z.strictObject({
  id: NodeIdSchema,
  parentId: NodeIdSchema.optional(),
  transform: TransformSchema.prefault({}),
});
/** The camera translation is subtracted from scene positions; its rotation rotates the stage. */
export const CameraSchema = z.strictObject({
  x: finite.default(0),
  y: finite.default(0),
  z: finite.default(0),
  rotateX: finite.default(0),
  rotateY: finite.default(0),
  rotateZ: finite.default(0),
  perspective: finite.min(100).max(10000).default(1400),
});
/** Depth of field. distance and focalLength share scene units; fStop sets the aperture. */
export const FocusSchema = z.strictObject({
  distance: finite.positive().default(1400),
  fStop: finite.min(0.7).max(128).default(8),
  focalLength: finite.min(1).max(300).default(50),
  maxBlur: finite.min(0).max(32).default(6),
});

export type Transform = z.output<typeof TransformSchema>;
export type TransformInput = z.input<typeof TransformSchema>;
export type Camera = z.output<typeof CameraSchema>;
export type CameraInput = z.input<typeof CameraSchema>;
export type Focus = z.output<typeof FocusSchema>;
export type FocusInput = z.input<typeof FocusSchema>;
export type SceneNode = z.output<typeof NodeSchema>;

export const DEFAULT_TRANSFORM: Transform = Object.freeze(TransformSchema.parse({}));
export const DEFAULT_CAMERA: Camera = Object.freeze(CameraSchema.parse({}));
export const DEFAULT_FOCUS: Focus = Object.freeze(FocusSchema.parse({}));

/** Tree rules shared by the schema and the live registry: unique ids, existing parents, no cycles. */
export function nodeTreeIssues(
  nodes: readonly { id: string; parentId?: string }[],
): { index: number; field: "id" | "parentId"; message: string }[] {
  const issues: { index: number; field: "id" | "parentId"; message: string }[] = [];
  const byId = new Map<string, { id: string; parentId?: string }>();
  nodes.forEach((node, index) => {
    if (byId.has(node.id)) issues.push({ index, field: "id", message: `Duplicate surface id: ${node.id}` });
    byId.set(node.id, node);
  });
  nodes.forEach((node, index) => {
    if (node.parentId && !byId.has(node.parentId)) {
      issues.push({ index, field: "parentId", message: `Missing parent: ${node.parentId}` });
      return;
    }
    const seen = new Set([node.id]);
    for (let parent = node.parentId; parent; parent = byId.get(parent)?.parentId) {
      if (seen.has(parent)) {
        issues.push({ index, field: "parentId", message: `Cyclic surface hierarchy at ${node.id}` });
        break;
      }
      seen.add(parent);
    }
  });
  return issues;
}

export const SceneSchema = z
  .strictObject({
    camera: CameraSchema.prefault({}),
    focus: FocusSchema.prefault({}),
    nodes: z.array(NodeSchema).max(1000),
  })
  .superRefine((scene, ctx) => {
    if (scene.focus.distance <= scene.focus.focalLength)
      ctx.addIssue({
        code: "custom",
        path: ["focus", "distance"],
        message: "Focus distance must exceed focal length.",
      });
    for (const issue of nodeTreeIssues(scene.nodes))
      ctx.addIssue({ code: "custom", path: ["nodes", issue.index, issue.field], message: issue.message });
  });
export type SceneData = z.output<typeof SceneSchema>;
export type SceneInput = z.input<typeof SceneSchema>;

export function validateScene(input: unknown): Result<SceneData> {
  const parsed = SceneSchema.safeParse(input);
  return parsed.success ? ok(parsed.data) : fail(zodIssues(parsed.error, "invalid-scene"));
}
