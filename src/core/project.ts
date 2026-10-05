import { z } from "zod";

/** Where Flick lives inside a host app, and how its studio is addressed. */
export const FLICK_DIR = "src/flick";
export const SCENES_DIR = "src/flick/scenes";
export const STATE_DIR = ".flick";
export const PROJECT_FILE = ".flick/project.json";
export const HANDOFF_FILE = "FLICK.md";
export const EXPORTS_DIR = ".flick/exports";
export const PACKAGE_NAME = "@flickjs/record";

/** `?flick=1` opens the studio; `&flick-scene=<id>` opens one scene. */
export const STUDIO_PARAM = "flick";
export const SCENE_PARAM = "flick-scene";

export const ADAPTERS = ["vite", "next-app", "next-pages", "react"] as const;
export const AdapterSchema = z.enum(ADAPTERS);
export type Adapter = z.output<typeof AdapterSchema>;

/** Only loopback HTTP origins: Flick drives the developer's own local dev server. */
export const LoopbackOriginSchema = z
  .string()
  .regex(/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?\/?$/, "Use a local dev server origin such as http://127.0.0.1:5173.")
  .transform((value) => value.replace(/\/$/, ""));

/** The ownership record: which files Flick generated and what it last wrote to each. */
export const ProjectFileSchema = z.strictObject({
  version: z.literal(1),
  adapter: AdapterSchema,
  /** Path of the studio on the dev server: "/" for wrapped apps, "/flick" for Next. */
  studioPath: z.string().startsWith("/"),
  devUrl: LoopbackOriginSchema,
  /** project-relative path -> sha256 of the content Flick wrote */
  files: z.record(z.string(), z.string()),
  /** The host entry file Flick connected, if any. The host owns this file. */
  entry: z.string().optional(),
});
export type ProjectFile = z.output<typeof ProjectFileSchema>;

export function studioUrl(origin: string, studioPath: string, sceneId?: string): string {
  const url = new URL(studioPath, origin);
  url.searchParams.set(STUDIO_PARAM, "1");
  if (sceneId) url.searchParams.set(SCENE_PARAM, sceneId);
  return url.toString();
}
