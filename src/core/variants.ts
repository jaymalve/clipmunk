import { z } from "zod";
import { partialOf } from "./partial";
import { RATIOS, type Ratio } from "./ratio";
import type { SceneDefinition } from "./recipe";
import { CameraSchema } from "./scene";

/** Scene variants: one scene rendered in several themes, locales and shapes. Clipmunk never knows
 * how the host does theming or translation: the scene reads its variant with `useSceneVariant()`
 * and hands it to the host's own providers. The variant reaches the page in the scene URL.
 */
export const VARIANT_PARAM = "clipmunk-variant";
export type SceneVariant = { theme?: string; locale?: string; ratio?: Ratio };

/** A ratio variant in a recipe: its own frame size, and optionally its own camera. */
export const RatioVariantSchema = z.strictObject({
  width: z.number().finite().positive().max(7680),
  height: z.number().finite().positive().max(7680),
  camera: partialOf(CameraSchema).optional(),
});
export const SceneVariantsSchema = z.strictObject({
  ratios: z.partialRecord(z.enum(RATIOS), RatioVariantSchema).optional(),
});

const VALUE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const ratioOf = (token: string) => RATIOS.find((ratio) => ratio.replace(":", "x") === token);

/** "theme:dark,locale:de,ratio:9x16" to a variant. Unknown keys and malformed values are dropped. */
export function parseVariant(text: string | null | undefined): SceneVariant {
  const variant: SceneVariant = {};
  for (const part of (text ?? "").split(",")) {
    const [key, value] = part.split(":") as [string, string | undefined];
    if (!value) continue;
    if (key === "theme" && VALUE.test(value)) variant.theme = value;
    else if (key === "locale" && VALUE.test(value)) variant.locale = value;
    else if (key === "ratio") {
      const ratio = ratioOf(value);
      if (ratio) variant.ratio = ratio;
    }
  }
  return variant;
}
export function formatVariant(variant: SceneVariant): string {
  return [
    variant.theme && `theme:${variant.theme}`,
    variant.locale && `locale:${variant.locale}`,
    variant.ratio && `ratio:${variant.ratio.replace(":", "x")}`,
  ]
    .filter(Boolean)
    .join(",");
}
/** The theme and locale part of a file name: "dark", "de", "dark-de". */
export const variantToken = (variant: SceneVariant) => [variant.theme, variant.locale].filter(Boolean).join("-");

/** Where a scene sits in the frame of a variant. With a ratio the recipe describes, the scene
 * renders at that size and may move its camera; with any other ratio it renders at its authored
 * size and is fitted, centred, into a frame of that shape (1080 pixels or the authored short side,
 * whichever is smaller, on the short side). It is never reflowed by Clipmunk.
 */
export type VariantFrame = {
  width: number;
  height: number;
  /** The scene's own size inside the frame, and how it is scaled and placed. */
  scene: { width: number; height: number; scale: number; left: number; top: number };
  camera?: z.output<typeof RatioVariantSchema>["camera"];
};
export function variantFrame(definition: SceneDefinition, ratio?: Ratio): VariantFrame {
  const { width, height } = definition;
  const authored = { width, height, scene: { width, height, scale: 1, left: 0, top: 0 } };
  if (!ratio) return authored;
  const own = definition.variants?.ratios?.[ratio];
  if (own)
    return {
      width: own.width,
      height: own.height,
      scene: { width: own.width, height: own.height, scale: 1, left: 0, top: 0 },
      ...(own.camera ? { camera: own.camera } : {}),
    };
  const [w, h] = ratio.split(":").map(Number) as [number, number];
  const short = Math.min(1080, Math.min(width, height));
  const even = (value: number) => Math.round(value / 2) * 2;
  const frame = { width: even((w / Math.min(w, h)) * short), height: even((h / Math.min(w, h)) * short) };
  const scale = Math.min(frame.width / width, frame.height / height);
  return {
    ...frame,
    scene: {
      width,
      height,
      scale,
      left: (frame.width - width * scale) / 2,
      top: (frame.height - height * scale) / 2,
    },
  };
}
