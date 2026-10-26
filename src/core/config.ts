import { z } from "zod";
import { PresetSchema } from "./presets";
import { ClipIdSchema } from "./recipe";
import { fail, ok, type Result, zodIssues } from "./result";
import { type RedactMode, RedactModeSchema, type TakeEdit } from "./take";

/** Project-wide settings in `clipmunk.config.json` at the project root. It is JSON, not code,
 * so Clipmunk reads it without running anything, and the daemon can write it (presets).
 * Every field is optional; a missing file is the empty config.
 */
export const CONFIG_FILE = "clipmunk.config.json";

const finite = z.number().finite();
const ColourSchema = z
  .string()
  .regex(
    /^(?:#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(?:rgba?|hsla?)\([^()]*\))$/i,
    "Use a hex colour such as #2B2117, or rgb(...) or hsl(...).",
  );

/** A CSS selector, checked as far as is possible without a browser: the recorder rejects
 * anything else when it runs it.
 */
export const SelectorSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(balanced, "This is not a CSS selector: check its brackets, parentheses and quotes.")
  .refine((value) => !/[{};]/.test(value), "A selector cannot contain {, } or ;.");
function balanced(value: string): boolean {
  const closing: Record<string, string> = { "[": "]", "(": ")" };
  const open: string[] = [];
  let quote: string | undefined;
  for (const char of value) {
    if (quote) {
      if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") quote = char;
    else if (closing[char]) open.push(closing[char]);
    else if (char === "]" || char === ")") {
      if (open.pop() !== char) return false;
    }
  }
  return !quote && open.length === 0;
}

/** A file inside the project, written relative to its root. */
const ProjectPathSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (value) => !/^(?:[/\\]|[a-z]:)/i.test(value) && !value.split(/[/\\]/).includes(".."),
    "Use a path inside the project, such as ./brand/logo.svg.",
  );

const SelectorsSchema = z.array(SelectorSchema).max(100);
const RedactionSchema = z.strictObject({
  selectors: SelectorsSchema,
  /** How new takes hide them. Each take can change it in its own edit. */
  mode: RedactModeSchema.optional(),
  /** Also blur them in the page while recording, so they never reach the screen video. */
  live: z.boolean().optional(),
});

export const BrandSchema = z.strictObject({
  /** Colour behind a take's recording. */
  backdrop: ColourSchema.optional(),
  /** Space around the recording, in pixels on the frame's short side (64 on a 1080p frame). */
  padding: finite.min(0).max(400).optional(),
  /** Corner radius of the recording, in pixels on the frame. */
  radius: finite.min(0).max(200).optional(),
  /** Not rendered yet: stored for the logo and end card. */
  logo: ProjectPathSchema.optional(),
  outro: z.boolean().optional(),
});
export type Brand = z.output<typeof BrandSchema>;

const LocaleSchema = z
  .string()
  .regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/, "Use a language tag such as en, de or pt-BR.");

export const ConfigSchema = z.strictObject({
  version: z.literal(1),
  brand: BrandSchema.optional(),
  /** Elements to hide in recordings: a list of selectors, or the selectors with how to hide them. */
  redact: z.union([SelectorsSchema, RedactionSchema]).optional(),
  /** Named partial edits with export options, keyed by a slug (core/presets.ts). */
  presets: z.record(ClipIdSchema, PresetSchema).optional(),
  /** The themes and locales scenes can be rendered in. */
  variants: z
    .strictObject({
      themes: z.array(ClipIdSchema).max(8).optional(),
      locales: z.array(LocaleSchema).max(16).optional(),
    })
    .optional(),
});
export type Config = z.output<typeof ConfigSchema>;
export const EMPTY_CONFIG: Config = { version: 1 };

/** Validate parsed JSON. Issue paths are prefixed with the file name. */
export function validateConfig(input: unknown): Result<Config> {
  const parsed = ConfigSchema.safeParse(input);
  if (parsed.success) return ok(parsed.data);
  return fail(
    zodIssues(parsed.error, "invalid-config").map((issue) => ({
      ...issue,
      path: issue.path ? `${CONFIG_FILE}: ${issue.path}` : CONFIG_FILE,
    })),
  );
}

/** A take edit with the brand's frame applied. Used once, when a take is saved, so changing
 * the brand later never changes a take that already exists.
 */
export function applyBrand(edit: TakeEdit, brand: Brand | undefined): TakeEdit {
  if (!brand) return edit;
  const { canvas } = edit;
  const short = Math.min(canvas.width, canvas.height);
  return {
    ...edit,
    canvas: {
      ...canvas,
      ...(brand.backdrop !== undefined ? { background: brand.backdrop } : {}),
      ...(brand.padding !== undefined ? { padding: Math.min(0.4, brand.padding / short) } : {}),
      ...(brand.radius !== undefined ? { radius: brand.radius } : {}),
    },
  };
}

/** The config's redaction settings, whichever way they are written. */
export function redactionOf(config: Pick<Config, "redact"> | undefined): {
  selectors: string[];
  mode: RedactMode;
  live: boolean;
} {
  const redact = config?.redact;
  if (!redact) return { selectors: [], mode: "blur", live: false };
  if (Array.isArray(redact)) return { selectors: redact, mode: "blur", live: false };
  return { selectors: redact.selectors, mode: redact.mode ?? "blur", live: redact.live ?? false };
}

/** A new take's edit with one redaction entry per selector, ahead of any it already has: the
 * config's selectors, and every selector the recording logged boxes for, so a take recorded
 * with redaction keeps it even when the config cannot be read at ingest. Like the brand, it is
 * applied once, when the take is saved.
 */
export function applyRedaction(
  edit: TakeEdit,
  config: Pick<Config, "redact"> | undefined,
  logged: Iterable<string> = [],
): TakeEdit {
  const { selectors, mode } = redactionOf(config);
  const known = new Set(edit.redact.flatMap((entry) => ("sel" in entry ? [entry.sel] : [])));
  const added = [...new Set([...selectors, ...logged])].filter((sel) => !known.has(sel)).map((sel) => ({ sel, mode }));
  return added.length ? { ...edit, redact: [...added, ...edit.redact] } : edit;
}

/** What `clipmunk init` writes when the project has no config yet. */
export const STARTER_CONFIG: Config = {
  version: 1,
  brand: { backdrop: "#0b0b0f", padding: 64, radius: 16 },
  redact: [],
  presets: {},
};
