import { z } from "zod";

/** Where Clipmunk lives inside a host app, and how its studio is addressed. */
export const CLIPMUNK_DIR = "src/clipmunk";
export const SCENES_DIR = "src/clipmunk/scenes";
export const STATE_DIR = ".clipmunk";
export const PROJECT_FILE = ".clipmunk/project.json";
export const HANDOFF_FILE = "CLIPMUNK.md";
export const EXPORTS_DIR = ".clipmunk/exports";
export const PACKAGE_NAME = "clipmunk";

/** `?clipmunk=1` opens the studio; `&clipmunk-scene=<id>` opens one scene. */
export const STUDIO_PARAM = "clipmunk";
export const SCENE_PARAM = "clipmunk-scene";
/** `?clipmunk-frame=1&clipmunk-scene=<id>` renders only that scene, for the Studio's iframe and for export. */
export const FRAME_PARAM = "clipmunk-frame";

export const ADAPTERS = ["vite", "next-app", "next-pages", "react"] as const;
export const AdapterSchema = z.enum(ADAPTERS);
export type Adapter = z.output<typeof AdapterSchema>;

/** Only loopback HTTP origins: Clipmunk drives the developer's own local dev server. */
export const LoopbackOriginSchema = z
  .string()
  .regex(
    /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?\/?$/,
    "Use a local dev server origin such as http://127.0.0.1:5173.",
  )
  .transform((value) => value.replace(/\/$/, ""));

/** The ownership record: which files Clipmunk generated and what it last wrote to each. */
export const ProjectFileSchema = z.strictObject({
  version: z.literal(1),
  adapter: AdapterSchema,
  /** Path of the studio on the dev server: "/" for wrapped apps, "/clipmunk" for Next. */
  studioPath: z.string().startsWith("/"),
  devUrl: LoopbackOriginSchema,
  /** project-relative path -> sha256 of the content Clipmunk wrote */
  files: z.record(z.string(), z.string()),
  /** The host entry file Clipmunk connected, if any. The host owns this file. */
  entry: z.string().optional(),
});
export type ProjectFile = z.output<typeof ProjectFileSchema>;

/** The frame page for one scene: just the scene, with the capture bridge and the Studio's messages. */
export function frameUrl(origin: string, studioPath: string, sceneId: string): string {
  const url = new URL(studioPath, origin);
  url.searchParams.set(FRAME_PARAM, "1");
  url.searchParams.set(SCENE_PARAM, sceneId);
  return url.toString();
}

export function studioUrl(origin: string, studioPath: string, sceneId?: string): string {
  const url = new URL(studioPath, origin);
  url.searchParams.set(STUDIO_PARAM, "1");
  if (sceneId) url.searchParams.set(SCENE_PARAM, sceneId);
  return url.toString();
}
