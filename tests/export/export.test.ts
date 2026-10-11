import { existsSync } from "node:fs";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateRecipe } from "../../src/core";
import { exportScene, probeVideo, snapshotScene } from "../../src/export";

/** Real exports of the example app: headless Chromium, the capture bridge and FFmpeg end to end. */
const root = path.resolve("examples/vite-app");
const restore = new Map<string, string>();
const made: string[] = [];
let server: ViteDevServer, url: string;
const out = (name: string) => {
  made.push(name);
  return name;
};

beforeAll(async () => {
  process.env.FLICK_FFMPEG ??= path.resolve("node_modules/ffmpeg-static/ffmpeg");
  // These operations remember the dev server and write snapshots; put the example back afterwards.
  for (const file of [".flick/project.json", "src/flick/scenes/rack-focus.scene.json"])
    restore.set(file, await readFile(path.join(root, file), "utf8"));
  server = await createServer({ root, server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
  await server.listen();
  url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`;
}, 60_000);
afterAll(async () => {
  await server?.close();
  for (const [file, content] of restore) await writeFile(path.join(root, file), content);
  for (const file of made) await rm(path.join(root, file), { force: true });
});

describe("scene export", () => {
  it("renders every frame at the requested size and cadence, and never overwrites", async () => {
    const output = out(".flick/exports/test-rack.mp4");
    const progress: number[] = [];
    const result = await exportScene(
      { sceneId: "rack-focus", url, output, fps: 30, width: 500, height: 300, workers: 1 },
      { root, onProgress: (done) => progress.push(done) },
    );
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.data).toMatchObject({
      output,
      fps: 30,
      frames: 45,
      durationMs: 1500,
      width: 500,
      height: 300,
      workers: 1,
    });
    expect(progress.at(-1)).toBe(45);
    expect(await probeVideo(output, root)).toMatchObject({
      frames: 45,
      width: 500,
      height: 300,
      fps: 30,
      durationMs: 1500,
    });

    const again = await exportScene({ sceneId: "rack-focus", url, output, fps: 30 }, { root });
    expect(again).toMatchObject({ ok: false, issues: [{ code: "output-exists" }] });
  }, 240_000);

  it("splits frames across workers and joins them into one file with the same frame count", async () => {
    const output = out(".flick/exports/test-rack-workers.mp4");
    const result = await exportScene(
      { sceneId: "rack-focus", url, output, fps: 30, width: 500, height: 300, workers: 3, draft: true },
      { root },
    );
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.data.workers).toBe(3);
    expect(await probeVideo(output, root)).toMatchObject({ frames: 45, width: 500, height: 300 });
    expect(
      (await readdir(path.join(root, ".flick/exports"))).filter((name) => name.startsWith(".flick-export-")),
    ).toEqual([]);
  }, 240_000);

  it("publishes nothing when cancelled", async () => {
    const output = ".flick/exports/test-cancelled.mp4";
    const controller = new AbortController();
    const result = await exportScene(
      { sceneId: "rack-focus", url, output, fps: 60, width: 500, height: 300, workers: 1 },
      { root, signal: controller.signal, onProgress: (done) => done === 3 && controller.abort() },
    );
    expect(result).toMatchObject({ ok: false, issues: [{ code: "export-cancelled" }] });
    expect(existsSync(path.join(root, output))).toBe(false);
  }, 240_000);

  it("explains bad requests, unknown scenes, a stopped server and a missing FFmpeg", async () => {
    expect(await exportScene({ sceneId: "rack-focus", url, output: "../escape.mp4" }, { root })).toMatchObject({
      ok: false,
      issues: [{ code: "invalid-export" }],
    });
    expect(await exportScene({ sceneId: "rack-focus", url: "https://example.com" }, { root })).toMatchObject({
      ok: false,
      issues: [{ code: "invalid-export" }],
    });
    expect(await exportScene({ sceneId: "nope", url }, { root })).toMatchObject({
      ok: false,
      issues: [{ code: "unknown-scene" }],
    });
    expect(
      await exportScene(
        { sceneId: "rack-focus", url: "http://127.0.0.1:9", output: ".flick/exports/never.mp4" },
        { root },
      ),
    ).toMatchObject({ ok: false, issues: [{ code: "server-unreachable" }] });
    const real = process.env.FLICK_FFMPEG;
    process.env.FLICK_FFMPEG = "/nonexistent/ffmpeg";
    try {
      expect(
        await exportScene(
          { sceneId: "rack-focus", url, output: ".flick/exports/never.mp4", width: 500, height: 300, workers: 1 },
          { root },
        ),
      ).toMatchObject({ ok: false, issues: [{ code: "missing-ffmpeg" }] });
    } finally {
      process.env.FLICK_FFMPEG = real;
    }
    expect(existsSync(path.join(root, ".flick/exports/never.mp4"))).toBe(false);
  }, 240_000);
});

describe("snapshot", () => {
  it("stores a small PNG of the chosen frame in the recipe", async () => {
    const result = await snapshotScene({ sceneId: "rack-focus", url, timeMs: 400 }, { root });
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.data).toMatchObject({
      sceneId: "rack-focus",
      source: "src/flick/scenes/rack-focus.scene.json",
      timeMs: 400,
    });
    const recipe = validateRecipe(JSON.parse(await readFile(path.join(root, result.data.source), "utf8")));
    expect(recipe.ok && recipe.data.snapshot?.image.startsWith("data:image/png;base64,iVBOR")).toBe(true);
    expect(recipe.ok && recipe.data.snapshot?.timeMs).toBe(400);
    expect(await snapshotScene({ sceneId: "rack-focus", url, timeMs: 99999 }, { root })).toMatchObject({
      ok: false,
      issues: [{ code: "invalid-snapshot" }],
    });
  }, 240_000);
});
