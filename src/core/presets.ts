import { z } from "zod";
import { EXPORT_FPS } from "./export";
import { MusicSchema } from "./music";
import { fail, ok, type Result, zodIssues } from "./result";
import { AudioSchema, CamSchema, CanvasSchema, CursorSchema, type TakeEdit, TakeEditSchema, ZoomSchema } from "./take";

/** A preset is a named partial edit plus export options, kept in clipmunk.config.json and
 * shared through the repository. Applying one merges it over a clip's own edit: sections
 * merge field by field, zoom and music are replaced whole, and `music: null` removes music.
 * The trim is never part of a preset, because it belongs to one recording.
 */
export const PRESET_FIELDS = ["canvas", "zoom", "cursor", "cam", "audio", "music"] as const;
export type PresetField = (typeof PRESET_FIELDS)[number];
export const RATIOS = ["16:9", "9:16", "1:1", "4:5"] as const;
export const EXPORT_FORMATS = ["mp4", "gif", "poster"] as const;

/** Every field of a section optional, and without its default, so a preset holds only what it sets. */
function partialOf<Shape extends z.ZodRawShape>(schema: z.ZodObject<Shape>) {
  const shape = Object.fromEntries(
    Object.entries(schema.shape).map(([key, field]) => [
      key,
      ((field instanceof z.ZodDefault ? field.unwrap() : field) as z.ZodType).optional(),
    ]),
  );
  return z.strictObject(shape) as unknown as z.ZodType<Partial<z.output<z.ZodObject<Shape>>>>;
}

export const PresetEditSchema = z.strictObject({
  canvas: partialOf(CanvasSchema).optional(),
  zoom: ZoomSchema.refine(
    (zoom) => zoom.mode !== "manual",
    "A preset cannot carry manual zoom keyframes: they are positions in one recording. Use auto or off.",
  ).optional(),
  cursor: partialOf(CursorSchema).optional(),
  cam: partialOf(CamSchema).optional(),
  audio: partialOf(AudioSchema).optional(),
});

export const ExportOptionsSchema = z.strictObject({
  size: z
    .string()
    .regex(/^\d{2,4}x\d{2,4}$/, "Use WIDTHxHEIGHT, such as 1920x1080.")
    .optional(),
  fps: z
    .number()
    .refine((fps) => (EXPORT_FPS as readonly number[]).includes(fps), `Use one of ${EXPORT_FPS.join(", ")}.`)
    .optional(),
  formats: z.array(z.enum(EXPORT_FORMATS)).min(1).optional(),
  ratios: z.array(z.enum(RATIOS)).min(1).optional(),
});

export const PresetSchema = z.strictObject({
  title: z.string().trim().min(1).max(60).optional(),
  description: z.string().trim().max(200).optional(),
  edit: PresetEditSchema.optional(),
  /** Music for takes and scenes alike; `null` means none. */
  music: MusicSchema.nullable().optional(),
  /** Used by exports from PR 9 of the Studio plan on. */
  export: ExportOptionsSchema.optional(),
});
export type Preset = z.output<typeof PresetSchema>;

/** The take edit with a preset applied. */
export function applyPreset(edit: TakeEdit, preset: Preset): Result<TakeEdit> {
  const next: Record<string, unknown> = { ...edit };
  const parts = preset.edit ?? {};
  for (const key of ["canvas", "cursor", "cam", "audio"] as const)
    if (parts[key]) next[key] = { ...edit[key], ...parts[key] };
  if (parts.zoom) next.zoom = parts.zoom;
  if (preset.music === null) delete next.music;
  else if (preset.music) next.music = preset.music;
  const parsed = TakeEditSchema.safeParse(next);
  return parsed.success ? ok(parsed.data) : fail(zodIssues(parsed.error, "invalid-preset"));
}

/** A preset made of the chosen sections of an edit, for "save current as preset". A music
 * seed is left out, so each clip that uses the preset keeps its own tune.
 */
export function presetFromEdit(
  edit: TakeEdit,
  fields: readonly PresetField[],
  extra: Pick<Preset, "title" | "description" | "export"> = {},
): Result<Preset> {
  if (fields.length === 0) return fail([{ code: "invalid-preset", message: "Choose at least one part to save." }]);
  const parts: Record<string, unknown> = {};
  let music: Preset["music"];
  for (const field of fields) {
    if (field === "music") {
      const { seed: _seed, ...rest } = edit.music ?? { seed: undefined };
      music = edit.music ? (rest as Preset["music"]) : null;
    } else if (field === "zoom" && edit.zoom.mode === "manual")
      return fail([
        {
          code: "invalid-preset",
          path: "zoom",
          message:
            "This take's zooms are hand-placed keyframes, which belong to this recording. Switch zoom to auto or off, or leave zoom out.",
        },
      ]);
    else parts[field] = edit[field];
  }
  const parsed = PresetSchema.safeParse({
    ...extra,
    ...(Object.keys(parts).length ? { edit: parts } : {}),
    ...(music !== undefined ? { music } : {}),
  });
  return parsed.success ? ok(parsed.data) : fail(zodIssues(parsed.error, "invalid-preset"));
}

/** A one-line summary for listings: "1080p · lofi · zoom up to 1.8x". */
export function describePreset(preset: Preset): string {
  const parts: string[] = [];
  const size = preset.export?.size?.split("x").map(Number);
  if (size) {
    const short = Math.min(size[0]!, size[1]!);
    parts.push(short === 2160 ? "4K" : `${short}p`);
  }
  if (preset.export?.fps) parts.push(`${preset.export.fps} fps`);
  if (preset.export?.ratios) parts.push(preset.export.ratios.join(", "));
  if (preset.export?.formats) parts.push(preset.export.formats.join(", "));
  if (preset.music === null) parts.push("no music");
  else if (preset.music) parts.push(preset.music.style);
  const { zoom, cursor, cam } = preset.edit ?? {};
  if (zoom?.mode === "off") parts.push("no zoom");
  else if (zoom?.mode === "auto") parts.push(`zoom up to ${zoom.params.maxScale}x`);
  if (cursor?.visible === false) parts.push("no cursor");
  if (cam?.visible === false) parts.push("no camera");
  else if (cam?.visible) parts.push("camera");
  return parts.join(" · ") || "no changes";
}
