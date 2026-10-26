import { execFile } from "node:child_process";
import { type ClipFreshness, compareSources, type SourceChange } from "../core";
import { hashFiles, readManifest } from "./manifest";
import { sha256 } from "./services";

/** Which exported clips are out of date: a clip is stale when a file its last export recorded has
 * a different hash now, or is gone. With `base` (a git ref), a file counts as changed when it
 * differs from that ref's copy instead (`git show <base>:./<file>`), so CI can ask what a pull
 * request changed regardless of how old the manifest is.
 */
export type FreshnessOptions = { base?: string };

/** git's stdout, or undefined when git is missing, the ref unknown or the file not in it. */
function git(root: string, args: string[]): Promise<Buffer | undefined> {
  return new Promise((resolve) =>
    execFile("git", args, { cwd: root, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 }, (error, stdout) =>
      resolve(error ? undefined : stdout),
    ),
  );
}

/** The short hash of the last commit that touched the file (since `base`, when given). */
async function lastCommit(root: string, file: string, base?: string): Promise<string | undefined> {
  // A change not committed yet was made in no commit.
  const status = await git(root, ["status", "--porcelain", "--", file]);
  if (!status || status.length) return undefined;
  const out = await git(root, ["log", "-1", "--format=%h", ...(base ? [`${base}..HEAD`] : []), "--", file]);
  return out?.toString("utf8").trim() || undefined;
}

export async function clipFreshness(root: string, options: FreshnessOptions = {}): Promise<ClipFreshness[]> {
  const manifest = await readManifest(root);
  if (options.base && !(await git(root, ["rev-parse", "--verify", "--quiet", `${options.base}^{commit}`])))
    throw new Error(`"${options.base}" is not a commit git knows here.`);
  const result: ClipFreshness[] = [];
  for (const [key, entry] of Object.entries(manifest.clips)) {
    const [kind, ...rest] = key.split(":");
    if (kind !== "scene" && kind !== "take" && kind !== "sequence") continue;
    const files = Object.keys(entry.files);
    const now = await hashFiles(root, files);
    let changes: SourceChange[];
    if (options.base) {
      changes = [];
      for (const file of files) {
        const before = await git(root, ["show", `${options.base}:./${file}`]);
        if (!(file in now)) {
          if (before) changes.push({ file, change: "missing" });
        } else if (!before || sha256(before) !== now[file]) changes.push({ file, change: "changed" });
      }
    } else changes = compareSources(entry.files, now);
    for (const change of changes) {
      const commit = change.change === "changed" ? await lastCommit(root, change.file, options.base) : undefined;
      if (commit) change.commit = commit;
    }
    result.push({
      clip: { kind, id: rest.join(":") },
      stale: changes.length > 0,
      changes,
      exportedAt: entry.exportedAt,
      outputs: entry.outputs,
    });
  }
  return result;
}
