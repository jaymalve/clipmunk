import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { describeStale } from "../core";
import { hashFiles } from "./manifest";
import { clipFreshness } from "./stale";

let root: string | undefined;
async function project(files: Record<string, string>) {
  root = await mkdtemp(path.join(os.tmpdir(), "clipmunk-stale-"));
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  return root;
}
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
const gitIn = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
    cwd: dir,
    encoding: "utf8",
  }).trim();

/** A manifest recording the files as they are now. */
async function exported(dir: string, clips: Record<string, string[]>) {
  const entries: Record<string, unknown> = {};
  for (const [key, files] of Object.entries(clips))
    entries[key] = {
      files: await hashFiles(dir, files),
      exportedAt: "2026-10-25T00:00:00.000Z",
      outputs: [`${key}.mp4`],
    };
  await writeFile(path.join(dir, ".clipmunk/manifest.json"), JSON.stringify({ version: 1, clips: entries }));
}

describe("clipFreshness", () => {
  it("marks a clip stale when a recorded file changed or is gone, and leaves the others", async () => {
    const dir = await project({
      ".clipmunk/.keep": "",
      "src/PlanCards.tsx": "export const PlanCards = 1;",
      "src/UsageChart.tsx": "export const UsageChart = 1;",
      "src/Other.tsx": "export const Other = 1;",
    });
    await exported(dir, {
      "scene:plans": ["src/PlanCards.tsx"],
      "scene:usage": ["src/UsageChart.tsx"],
      "scene:other": ["src/Other.tsx"],
    });
    expect((await clipFreshness(dir)).every((clip) => !clip.stale)).toBe(true);
    await writeFile(path.join(dir, "src/PlanCards.tsx"), "export const PlanCards = 2;");
    await rm(path.join(dir, "src/UsageChart.tsx"));
    const clips = await clipFreshness(dir);
    expect(clips.map((clip) => [clip.clip.id, clip.stale, clip.changes])).toEqual([
      ["plans", true, [{ file: "src/PlanCards.tsx", change: "changed" }]],
      ["usage", true, [{ file: "src/UsageChart.tsx", change: "missing" }]],
      ["other", false, []],
    ]);
  });

  it("compares with a git ref, naming the commits that changed each file", async () => {
    const dir = await project({
      ".clipmunk/.keep": "",
      "src/PlanCards.tsx": "export const PlanCards = 1;",
      "src/UsageChart.tsx": "export const UsageChart = 1;",
    });
    gitIn(dir, "init", "-q", "-b", "main");
    await exported(dir, { "scene:plans": ["src/PlanCards.tsx"], "scene:usage": ["src/UsageChart.tsx"] });
    gitIn(dir, "add", "-A");
    gitIn(dir, "commit", "-q", "-m", "base");
    gitIn(dir, "checkout", "-q", "-b", "feature");
    await writeFile(path.join(dir, "src/PlanCards.tsx"), "export const PlanCards = 2;");
    await writeFile(path.join(dir, "src/UsageChart.tsx"), "export const UsageChart = 2;");
    gitIn(dir, "commit", "-q", "-am", "change both");
    const commit = gitIn(dir, "log", "-1", "--format=%h");

    const clips = await clipFreshness(dir, { base: "main" });
    expect(clips.map((clip) => clip.changes)).toEqual([
      [{ file: "src/PlanCards.tsx", change: "changed", commit }],
      [{ file: "src/UsageChart.tsx", change: "changed", commit }],
    ]);
    expect(describeStale(clips)).toBe(
      `2 clips are out of date. <PlanCards /> and <UsageChart /> changed in ${commit}.`,
    );
    // Against the feature branch itself nothing changed; an unknown ref is refused.
    expect((await clipFreshness(dir, { base: "feature" })).every((clip) => !clip.stale)).toBe(true);
    await expect(clipFreshness(dir, { base: "nope" })).rejects.toThrow("not a commit");
    // A change not committed yet has no commit.
    await writeFile(path.join(dir, "src/PlanCards.tsx"), "export const PlanCards = 3;");
    expect((await clipFreshness(dir))[0]!.changes).toEqual([{ file: "src/PlanCards.tsx", change: "changed" }]);
  });
});
