import { execFile } from "node:child_process";
import { type ClipFreshness, COMMENT_MARKER, fail, formatPrComment, ok, type Result } from "../core";
import { clipFreshness } from "../project";

/** "Post to PR" in the Studio: the same comment the GitHub Action writes, posted through the
 * developer's own `gh` CLI, signed in as them. It is the only thing Clipmunk sends off the
 * machine, and only when they press the button. `CLIPMUNK_GH` names another `gh` (tests).
 */
type Run = { ok: boolean; stdout: string; stderr: string };
function gh(root: string, args: string[], input?: string): Promise<Run> {
  return new Promise((resolve) => {
    const child = execFile(
      process.env.CLIPMUNK_GH ?? "gh",
      args,
      { cwd: root, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) =>
        resolve({ ok: !error, stdout: String(stdout), stderr: String(stderr || error?.message || "") }),
    );
    // Always closed, so a gh that reads stdin never waits for more.
    child.stdin?.end(input ?? "");
  });
}

export type PrPreview = { number: number; url: string; base: string; comment: string };

export async function previewPrComment(root: string): Promise<Result<PrPreview>> {
  const view = await gh(root, ["pr", "view", "--json", "number,url,baseRefName"]);
  let pr: { number: number; url: string; baseRefName: string };
  try {
    pr = JSON.parse(view.stdout);
  } catch {
    return fail([
      {
        code: "no-pull-request",
        message: view.stderr.includes("ENOENT")
          ? "Posting to a pull request needs the GitHub CLI (gh), installed and signed in."
          : `No pull request found for this branch. ${view.stderr.trim().split("\n")[0] ?? ""}`.trim(),
      },
    ]);
  }
  // The PR's base as this clone knows it; without that ref, staleness since the last export.
  const candidates = [`origin/${pr.baseRefName}`, pr.baseRefName];
  let base: string | undefined;
  let clips: ClipFreshness[] | undefined;
  for (const candidate of candidates) {
    try {
      clips = await clipFreshness(root, { base: candidate });
      base = candidate;
      break;
    } catch {
      // Not a ref here: try the next.
    }
  }
  clips ??= await clipFreshness(root);
  const comment = formatPrComment({
    ...(base ? { base } : {}),
    clips,
    source: "Posted from the Clipmunk Studio",
  });
  return ok({ number: pr.number, url: pr.url, base: base ?? pr.baseRefName, comment });
}

/** Post the comment, or update the one Clipmunk posted before. */
export async function postPrComment(root: string): Promise<Result<{ url: string; updated: boolean }>> {
  const preview = await previewPrComment(root);
  if (!preview.ok) return preview;
  const { number, comment } = preview.data;
  const found = await gh(root, [
    "api",
    `repos/{owner}/{repo}/issues/${number}/comments`,
    "--paginate",
    "--jq",
    `.[] | select(.body | contains("${COMMENT_MARKER}")) | .id`,
  ]);
  if (!found.ok)
    return fail([{ code: "gh-failed", message: `gh could not read the comments: ${found.stderr.trim()}` }]);
  const existing = found.stdout.trim().split("\n")[0];
  const sent = await gh(
    root,
    existing
      ? ["api", "-X", "PATCH", `repos/{owner}/{repo}/issues/comments/${existing}`, "--input", "-"]
      : ["api", "-X", "POST", `repos/{owner}/{repo}/issues/${number}/comments`, "--input", "-"],
    JSON.stringify({ body: comment }),
  );
  if (!sent.ok) return fail([{ code: "gh-failed", message: `gh could not post the comment: ${sent.stderr.trim()}` }]);
  let url = preview.data.url;
  try {
    url = (JSON.parse(sent.stdout) as { html_url?: string }).html_url ?? url;
  } catch {
    // The PR's own address will do.
  }
  return ok({ url, updated: !!existing });
}
