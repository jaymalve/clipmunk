import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Issue } from "../core";

/** Filesystem effects for project operations. Every path is resolved inside the
 * project root; nothing here decides policy.
 */
export class Fault extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly path?: string,
  ) {
    super(message);
  }
}
export const toIssues = (error: unknown, fallbackCode: string): Issue[] =>
  error instanceof Fault
    ? [{ code: error.code, path: error.path, message: error.message }]
    : [{ code: fallbackCode, message: error instanceof Error ? error.message : String(error) }];

export const sha256 = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
export const toPosix = (value: string) => value.split(path.sep).join("/");

/** Absolute path for a project-relative one. Rejects traversal and symlinks that leave the root. */
export async function resolveInside(root: string, relative: string): Promise<string> {
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes(".."))
    throw new Fault("outside-project", `"${relative}" is not a path inside the project.`, relative);
  const base = await realpath(root);
  const target = path.join(base, relative);
  // Check the deepest existing ancestor so a symlinked directory cannot redirect a write.
  for (let probe = target; probe.startsWith(base); probe = path.dirname(probe)) {
    const real = await realpath(probe).catch(() => undefined);
    if (real === undefined) continue;
    if (real !== base && !real.startsWith(base + path.sep))
      throw new Fault("outside-project", `"${relative}" resolves outside the project through a symlink.`, relative);
    break;
  }
  return target;
}

export async function readText(root: string, relative: string): Promise<string | undefined> {
  try {
    return await readFile(await resolveInside(root, relative), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "EISDIR")
      return undefined;
    throw error;
  }
}

export async function writeText(root: string, relative: string, content: string | Buffer): Promise<void> {
  const target = await resolveInside(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporary, content);
  await rename(temporary, target).catch(async (error) => {
    await rm(temporary, { force: true });
    throw error;
  });
}

export async function exists(root: string, relative: string): Promise<boolean> {
  return lstat(await resolveInside(root, relative)).then(
    () => true,
    () => false,
  );
}

export async function listFiles(root: string, relative: string): Promise<string[]> {
  try {
    const entries = await readdir(await resolveInside(root, relative), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
