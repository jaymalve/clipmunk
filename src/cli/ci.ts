import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { type ClipFreshness, exportFormatsOf, formatPrComment, type ReExport } from "../core";
import { exportJob } from "../export";
import { clipFreshness, resolveInside, writeText } from "../project";
import type { Command } from "./invocation";

/** What the GitHub Action runs. `clipmunk ci export --base <ref>` finds the clips a pull request
 * made stale, exports the stale scenes and sequences again (takes cannot be: they are recordings),
 * copies the new files to `.clipmunk/ci/media` for the workflow to upload, and keeps what it did in
 * `.clipmunk/ci/result.json`. `clipmunk ci comment` then prints the PR comment from it, with the
 * links only known after the upload.
 */
export const CI_DIR = ".clipmunk/ci";
const RESULT = `${CI_DIR}/result.json`;
type CiResult = { base: string; clips: ClipFreshness[]; reexported: ReExport[]; media: string[] };
type Exporter = typeof exportJob;

export async function ciExport(
  root: string,
  options: { base: string; url?: string; exporter?: Exporter; log?: (line: string) => void },
): Promise<CiResult> {
  const exporter = options.exporter ?? exportJob;
  const clips = await clipFreshness(root, { base: options.base });
  const media = await resolveInside(root, `${CI_DIR}/media`);
  await rm(media, { recursive: true, force: true });
  await mkdir(media, { recursive: true });
  const reexported: ReExport[] = [];
  const files: string[] = [];
  for (const clip of clips.filter((item) => item.stale && item.clip.kind !== "take")) {
    options.log?.(`Exporting ${clip.clip.kind} ${clip.clip.id} again`);
    const result = await exporter(
      { clip: clip.clip, formats: exportFormatsOf(clip.outputs), ...(options.url ? { url: options.url } : {}) },
      { root },
    );
    if (!result.ok) {
      reexported.push({ clip: clip.clip, outputs: [], problem: result.issues.map((issue) => issue.message).join(" ") });
      continue;
    }
    const outputs = result.data.outputs.map((item) => item.output);
    reexported.push({ clip: clip.clip, outputs });
    for (const output of outputs) {
      const target = `${CI_DIR}/media/${path.basename(output)}`;
      await copyFile(await resolveInside(root, output), await resolveInside(root, target));
      files.push(target);
    }
  }
  const result: CiResult = { base: options.base, clips, reexported, media: files };
  await writeText(root, RESULT, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

export async function ciComment(
  root: string,
  options: { base?: string; artifactUrl?: string; mediaBase?: string; source?: string },
): Promise<string> {
  let result: CiResult | undefined;
  try {
    result = JSON.parse(await readFile(await resolveInside(root, RESULT), "utf8"));
  } catch {
    result = undefined;
  }
  const base = result?.base ?? options.base;
  const clips = result?.clips ?? (await clipFreshness(root, base ? { base } : {}));
  const mediaBase = options.mediaBase?.replace(/\/?$/, "/");
  return formatPrComment({
    ...(base ? { base } : {}),
    clips,
    reexported: result?.reexported ?? [],
    ...(options.artifactUrl ? { artifactUrl: options.artifactUrl } : {}),
    ...(mediaBase ? { mediaUrl: (output: string) => `${mediaBase}${encodeURIComponent(path.basename(output))}` } : {}),
    source: options.source ?? "Posted by the Clipmunk action",
  });
}

export const ci: Command = async ({ args, values, context, print, usage, io }) => {
  const [step] = args;
  const string = (name: "base" | "url" | "artifact-url" | "media-url") =>
    typeof values[name] === "string" ? values[name] : undefined;
  if (step === "export") {
    const base = string("base");
    if (!base) return usage("clipmunk ci export needs --base <git ref>, the branch the pull request goes into.");
    try {
      const result = await ciExport(context.root, { base, url: string("url"), log: (line) => io.err(line) });
      return print({ ok: true, data: result }, (data) => {
        const stale = data.clips.filter((clip) => clip.stale).length;
        return `${stale} of ${data.clips.length} exported clips are out of date; ${data.media.length} files exported again into ${CI_DIR}/media.`;
      });
    } catch (error) {
      return print({ ok: false, issues: [{ code: "ci-failed", message: (error as Error).message }] }, String);
    }
  }
  if (step === "comment") {
    const body = await ciComment(context.root, {
      base: string("base"),
      artifactUrl: string("artifact-url"),
      mediaBase: string("media-url"),
    });
    io.out(body.trimEnd());
    return 0;
  }
  return usage(
    "clipmunk ci export --base <ref> [--url <origin>] | clipmunk ci comment [--artifact-url <url>] [--media-url <base>]",
  );
};
