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

/** How a clip's sources compare with what its last export recorded. `commit` is the latest one
 * that touched the file, when git knows it. */
export type SourceChange = { file: string; change: "changed" | "missing"; commit?: string };
export type ClipFreshness = {
  clip: { kind: "scene" | "take" | "sequence"; id: string };
  stale: boolean;
  changes: SourceChange[];
  exportedAt: string;
  outputs: string[];
};

/** `now` holds the current hash of each file that exists. */
export function compareSources(recorded: Record<string, string>, now: Record<string, string>): SourceChange[] {
  return Object.keys(recorded)
    .sort()
    .flatMap((file): SourceChange[] =>
      !(file in now)
        ? [{ file, change: "missing" }]
        : now[file] !== recorded[file]
          ? [{ file, change: "changed" }]
          : [],
    );
}

/** `<PlanCards />` for a component file, otherwise the path. */
export function sourceLabel(file: string): string {
  const name = file
    .split("/")
    .pop()!
    .replace(/\.[^.]+$/, "");
  return /\.[jt]sx$/.test(file) && /^[A-Z][A-Za-z0-9]*$/.test(name) ? `<${name} />` : file;
}

const list = (items: string[]) =>
  items.length <= 2 ? items.join(" and ") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

/** "2 clips are out of date. <PlanCards /> and <UsageChart /> changed in a3f9c1." */
export function describeStale(clips: readonly ClipFreshness[]): string | undefined {
  const stale = clips.filter((clip) => clip.stale);
  if (!stale.length) return undefined;
  const changes = stale.flatMap((clip) => clip.changes);
  const files = [...new Set(changes.map((change) => change.file))];
  const labels = files.slice(0, 4).map(sourceLabel);
  if (files.length > 4) labels.push(`${files.length - 4} more`);
  const commits = [...new Set(changes.flatMap((change) => (change.commit ? [change.commit] : [])))];
  const gone = changes.every((change) => change.change === "missing");
  const verb = gone ? (files.length === 1 ? "was removed" : "were removed") : "changed";
  const when = commits.length ? ` in ${list(commits.slice(0, 3))}` : "";
  return `${stale.length} ${stale.length === 1 ? "clip is" : "clips are"} out of date. ${list(labels)} ${verb}${when}.`;
}
