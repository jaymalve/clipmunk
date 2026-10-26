import { z } from "zod";

export const MANIFEST_FILE = ".clipmunk/manifest.json";

/** `.clipmunk/manifest.json`, committed: for each exported clip, the source files it was made
 * from with their hashes, when, and what it made. A later check compares the hashes with the
 * files now to say which videos are out of date.
 */
export const ManifestEntrySchema = z.strictObject({
  files: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)),
  exportedAt: z.string(),
  outputs: z.array(z.string()),
});
export const ManifestSchema = z.strictObject({
  version: z.literal(1),
  /** Keyed `<kind>:<id>`, like "scene:rack-focus". */
  clips: z.record(z.string(), ManifestEntrySchema),
});
export type ManifestEntry = z.output<typeof ManifestEntrySchema>;
export type Manifest = z.output<typeof ManifestSchema>;
