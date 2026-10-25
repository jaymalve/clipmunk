import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashFiles } from "../project";
import { ciComment, ciExport } from "./ci";

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
    cwd: dir,
    encoding: "utf8",
  }).trim();

/** A repository on a feature branch that changed the component one scene and one take show. */
async function fixture() {
  root = await mkdtemp(path.join(os.tmpdir(), "clipmunk-ci-"));
  const files = {
    "src/PlanCards.tsx": "export const PlanCards = 1;",
    "src/Hero.tsx": "export const Hero = 1;",
    ".clipmunk/takes/onboarding/edit.json": "{}",
  };
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  const entry = async (sources: string[], outputs: string[]) => ({
    files: await hashFiles(root!, sources),
    exportedAt: "2026-10-25T00:00:00.000Z",
    outputs,
  });
  const manifest = {
    version: 1,
    clips: {
      "scene:hero": await entry(["src/Hero.tsx"], [".clipmunk/exports/hero.mp4"]),
      "scene:plans": await entry(["src/PlanCards.tsx"], [".clipmunk/exports/plans.mp4", ".clipmunk/exports/plans.gif"]),
      "take:onboarding": await entry(
        [".clipmunk/takes/onboarding/edit.json", "src/PlanCards.tsx"],
        [".clipmunk/exports/onboarding.mp4"],
      ),
    },
  };
  await writeFile(path.join(root, ".clipmunk/manifest.json"), JSON.stringify(manifest));
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  git(root, "checkout", "-q", "-b", "feature");
  await writeFile(path.join(root, "src/PlanCards.tsx"), "export const PlanCards = 2;");
  git(root, "commit", "-q", "-am", "new plan cards");
  return { root, commit: git(root, "log", "-1", "--format=%h") };
}

describe("clipmunk ci", () => {
  it("exports the stale scenes again, leaves takes to be recorded, and writes the comment", async () => {
    const { root, commit } = await fixture();
    const asked: unknown[] = [];
    const result = await ciExport(root, {
      base: "main",
      url: "http://127.0.0.1:5173",
      exporter: async (input) => {
        asked.push(input);
        const outputs = [".clipmunk/exports/plans-1.mp4", ".clipmunk/exports/plans-1.gif"];
        await mkdir(path.join(root, ".clipmunk/exports"), { recursive: true });
        for (const output of outputs) await writeFile(path.join(root, output), "video");
        return { ok: true, data: { outputs: outputs.map((output) => ({ output }) as never), elapsedMs: 1 } };
      },
    });
    // Only the stale scene, in the formats it was exported in before.
    expect(asked).toEqual([
      { clip: { kind: "scene", id: "plans" }, formats: ["mp4", "gif"], url: "http://127.0.0.1:5173" },
    ]);
    expect(result.media).toEqual([".clipmunk/ci/media/plans-1.mp4", ".clipmunk/ci/media/plans-1.gif"]);
    expect(existsSync(path.join(root, ".clipmunk/ci/media/plans-1.gif"))).toBe(true);
    expect(result.clips.filter((clip) => clip.stale).map((clip) => clip.clip.id)).toEqual(["plans", "onboarding"]);

    const body = await ciComment(root, {
      artifactUrl: "https://github.com/o/r/actions/runs/1/artifacts/2",
      mediaBase: "https://github.com/o/r/raw/clipmunk-media/pr-7",
    });
    expect(body).toContain(`2 clips are out of date. <PlanCards /> changed in ${commit}. Compared with \`main\`.`);
    expect(body).toContain(
      "Exported again: `plans-1.mp4`, `plans-1.gif` ([download](https://github.com/o/r/actions/runs/1/artifacts/2))",
    );
    expect(body).toContain("| take `onboarding` |");
    expect(body).toContain("![plans](https://github.com/o/r/raw/clipmunk-media/pr-7/plans-1.gif)");
  });

  it("says what failed to export", async () => {
    const { root } = await fixture();
    await ciExport(root, {
      base: "main",
      exporter: async () => ({
        ok: false,
        issues: [{ code: "export-failed", message: "The dev server did not answer." }],
      }),
    });
    expect(await ciComment(root, {})).toContain("Could not export it again: The dev server did not answer.");
  });
});
