import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Daemon, startDaemon } from "../../src/daemon";

/** "Post to PR" through a stand-in for the developer's gh, which records what it was asked. */
let root: string, daemon: Daemon, calls: string;
const FAKE_GH = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
let input = "";
try { input = fs.readFileSync(0, "utf8"); } catch {}
fs.appendFileSync(process.env.GH_CALLS, JSON.stringify({ args, input }) + "\\n");
const posted = fs.existsSync(process.env.GH_CALLS + ".posted");
if (args[0] === "pr") process.stdout.write(JSON.stringify({ number: 7, url: "https://github.com/o/r/pull/7", baseRefName: "main" }));
else if (args.includes("--paginate")) process.stdout.write(posted ? "991\\n" : "");
else if (args.includes("POST")) { fs.writeFileSync(process.env.GH_CALLS + ".posted", ""); process.stdout.write(JSON.stringify({ html_url: "https://github.com/o/r/pull/7#issuecomment-991" })); }
else process.stdout.write(JSON.stringify({ html_url: "https://github.com/o/r/pull/7#issuecomment-991" }));
`;

const api = (route: string, method = "GET") =>
  fetch(`${daemon.origin}${route}`, {
    method,
    headers: { authorization: `Bearer ${daemon.token}`, "content-type": "application/json" },
    ...(method === "POST" ? { body: "{}" } : {}),
  }).then((response) => response.json() as Promise<any>);
const log = async () =>
  (await readFile(calls, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { args: string[]; input: string });

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "clipmunk-pr-"));
  await mkdir(path.join(root, ".clipmunk"), { recursive: true });
  const gh = path.join(root, "gh.cjs");
  await writeFile(gh, FAKE_GH);
  await chmod(gh, 0o755);
  calls = path.join(root, "calls.jsonl");
  process.env.CLIPMUNK_GH = gh;
  process.env.GH_CALLS = calls;
  daemon = await startDaemon({ root, port: 0, announce: false });
});
afterAll(async () => {
  await daemon?.close();
  delete process.env.CLIPMUNK_GH;
  await rm(root, { recursive: true, force: true });
});

describe("posting to the pull request", () => {
  it("previews the comment, posts it once, then updates the same comment", async () => {
    const preview = await api("/v1/pr");
    expect(preview.data).toMatchObject({ number: 7, url: "https://github.com/o/r/pull/7" });
    expect(preview.data.comment).toContain("<!-- clipmunk:pr-comment -->");
    expect(preview.data.comment).toContain("Nothing has been exported yet");
    // Previewing sends nothing.
    expect((await log()).every((call) => !call.args.includes("-X"))).toBe(true);

    const posted = await api("/v1/pr/comment", "POST");
    expect(posted.data).toEqual({ url: "https://github.com/o/r/pull/7#issuecomment-991", updated: false });
    const sent = (await log()).find((call) => call.args.includes("POST"))!;
    expect(sent.args).toEqual(["api", "-X", "POST", "repos/{owner}/{repo}/issues/7/comments", "--input", "-"]);
    expect(JSON.parse(sent.input).body).toContain("Posted from the Clipmunk Studio");

    const again = await api("/v1/pr/comment", "POST");
    expect(again.data.updated).toBe(true);
    expect((await log()).find((call) => call.args.includes("PATCH"))!.args).toContain(
      "repos/{owner}/{repo}/issues/comments/991",
    );
  });

  it("says what is missing when there is no gh or no pull request", async () => {
    process.env.CLIPMUNK_GH = path.join(root, "no-such-gh");
    try {
      const result = await api("/v1/pr");
      expect(result.ok).toBe(false);
      expect(result.issues[0].message).toContain("needs the GitHub CLI");
    } finally {
      process.env.CLIPMUNK_GH = path.join(root, "gh.cjs");
    }
  });
});
