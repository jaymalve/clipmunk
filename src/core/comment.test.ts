import { describe, expect, it } from "vitest";
import { COMMENT_MARKER, formatPrComment } from "./comment";
import type { ClipFreshness } from "./manifest";

const clip = (kind: ClipFreshness["clip"]["kind"], id: string, changes: ClipFreshness["changes"]): ClipFreshness => ({
  clip: { kind, id },
  stale: changes.length > 0,
  changes,
  exportedAt: "2026-10-25T00:00:00.000Z",
  outputs: [`.clipmunk/exports/${id}.mp4`],
});

describe("formatPrComment", () => {
  it("lists each stale clip, what changed, and what happened to its video", () => {
    const body = formatPrComment({
      base: "origin/main",
      clips: [
        clip("scene", "plans", [{ file: "src/components/PlanCards.tsx", change: "changed", commit: "a3f9c1" }]),
        clip("scene", "usage", [{ file: "src/components/UsageChart.tsx", change: "changed", commit: "a3f9c1" }]),
        clip("take", "onboarding", [{ file: "src/App.tsx", change: "changed", commit: "b7d2e0" }]),
        clip("scene", "hero", []),
      ],
      reexported: [
        {
          clip: { kind: "scene", id: "plans" },
          outputs: [".clipmunk/exports/plans.mp4", ".clipmunk/exports/plans.gif"],
        },
        { clip: { kind: "scene", id: "usage" }, outputs: [], problem: "the dev server did not answer" },
      ],
      artifactUrl: "https://github.com/o/r/actions/runs/1/artifacts/2",
      mediaUrl: (output) => `https://media.example/${output.split("/").pop()}`,
      source: "Posted by the Clipmunk action",
    });
    expect(body.startsWith(`${COMMENT_MARKER}\n### Clipmunk\n`)).toBe(true);
    expect(body).toContain(
      "3 clips are out of date. <PlanCards />, <UsageChart /> and <App /> changed in a3f9c1 and b7d2e0.",
    );
    expect(body).toContain(
      "| scene `plans` | `<PlanCards />` `src/components/PlanCards.tsx` (a3f9c1) | Exported again: `plans.mp4`, `plans.gif` ([download](https://github.com/o/r/actions/runs/1/artifacts/2)) |",
    );
    expect(body).toContain(
      "| scene `usage` | `<UsageChart />` `src/components/UsageChart.tsx` (a3f9c1) | Could not export it again: the dev server did not answer |",
    );
    expect(body).toContain(
      "| take `onboarding` | `<App />` `src/App.tsx` (b7d2e0) | Record it again: a take is a recording of the old screen. |",
    );
    expect(body).not.toContain("`hero`");
    expect(body).toContain("![plans](https://media.example/plans.gif)");
    expect(body).toContain("<sub>Posted by the Clipmunk action.");
  });

  it("says when nothing is out of date, or nothing was exported", () => {
    expect(formatPrComment({ base: "origin/main", clips: [clip("scene", "hero", [])] })).toContain(
      "No filmed source changed by this pull request (compared with `origin/main`). The exported clip is up to date.",
    );
    expect(formatPrComment({ clips: [] })).toContain("Nothing has been exported yet");
  });
});
