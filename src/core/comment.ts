import { type ClipFreshness, describeStale, sourceLabel } from "./manifest";

/** The pull request comment: one per PR, found again by its marker and updated in place. The
 * GitHub Action writes it after re-exporting stale scenes in CI; the Studio's "Post to PR" writes
 * the same one through the developer's own `gh`. GitHub cannot attach a video to a comment, so
 * videos are linked (the workflow's artifact), and posters and GIFs are shown inline only when
 * they were published somewhere a comment can load them (`mediaUrl`).
 */
export const COMMENT_MARKER = "<!-- clipmunk:pr-comment -->";

export type ReExport = { clip: ClipFreshness["clip"]; outputs: string[]; problem?: string };
export type CommentInput = {
  /** The ref the PR is compared with. */
  base?: string;
  /** Every exported clip and its staleness. */
  clips: readonly ClipFreshness[];
  /** What was exported again for this comment, in CI. */
  reexported?: readonly ReExport[];
  /** Where the re-exported files can be downloaded: the workflow run's artifact. */
  artifactUrl?: string;
  /** A URL a comment can load for an output file (posters and GIFs), when they were published. */
  mediaUrl?: (output: string) => string | undefined;
  /** Where this comment came from, for its footer. */
  source?: string;
};

/** The formats a clip was last exported in (from its outputs), to export it again the same way. */
export function exportFormatsOf(outputs: readonly string[]): ("mp4" | "gif" | "poster")[] {
  const formats = new Set(
    outputs.map((output) => (output.endsWith(".gif") ? "gif" : output.endsWith(".png") ? "poster" : "mp4")),
  );
  return formats.size ? [...formats] : ["mp4"];
}

const fileName = (output: string) => output.split("/").pop()!;
const code = (text: string) => `\`${text.replace(/`/g, "'")}\``;
const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function formatPrComment(input: CommentInput): string {
  const lines = [COMMENT_MARKER, "### Clipmunk", ""];
  const stale = input.clips.filter((clip) => clip.stale);
  const since = input.base ? ` by this pull request (compared with ${code(input.base)})` : "";
  if (!input.clips.length) {
    lines.push("Nothing has been exported yet, so no video can be out of date. Export a clip to start tracking it.");
  } else if (!stale.length) {
    lines.push(
      `No filmed source changed${since}. ${input.clips.length === 1 ? "The exported clip is" : `All ${input.clips.length} exported clips are`} up to date.`,
    );
  } else {
    lines.push(`${describeStale(stale)}${input.base ? ` Compared with ${code(input.base)}.` : ""}`, "");
    lines.push("| Clip | What changed | Video |", "|---|---|---|");
    for (const clip of stale) {
      const changed = clip.changes
        .map((change) => {
          const label = sourceLabel(change.file);
          const name = label === change.file ? code(change.file) : `${code(label)} ${code(change.file)}`;
          return `${name}${change.change === "missing" ? " removed" : ""}${change.commit ? ` (${change.commit})` : ""}`;
        })
        .join("<br>");
      const redone = input.reexported?.find(
        (item) => item.clip.kind === clip.clip.kind && item.clip.id === clip.clip.id,
      );
      const video =
        clip.clip.kind === "take"
          ? "Record it again: a take is a recording of the old screen."
          : redone?.problem
            ? `Could not export it again: ${redone.problem}`
            : redone
              ? `Exported again: ${redone.outputs.map((output) => code(fileName(output))).join(", ")}${input.artifactUrl ? ` ([download](${input.artifactUrl}))` : ""}`
              : "Export it again (clipmunk export, or Re-export in the Studio).";
      lines.push(`| ${clip.clip.kind} ${code(clip.clip.id)} | ${cell(changed)} | ${cell(video)} |`);
    }
    const previews = (input.reexported ?? []).flatMap((item) =>
      item.outputs
        .filter((output) => /\.(gif|png)$/.test(output))
        .flatMap((output) => {
          const url = input.mediaUrl?.(output);
          return url ? [`![${item.clip.id}](${url})`] : [];
        }),
    );
    if (previews.length) lines.push("", ...previews);
  }
  lines.push("", `<sub>${input.source ?? "Posted by Clipmunk"}. This comment is updated in place.</sub>`);
  return `${lines.join("\n")}\n`;
}
