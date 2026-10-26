import { existsSync } from "node:fs";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateRecipe } from "../../src/core";
import { exportJob, exportScene, launchBrowser, probeVideo, snapshotScene } from "../../src/export";
import { openClip } from "../../src/export/browser";
import { listScenes } from "../../src/project";
import { colourAt, near } from "../support/media";

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
  process.env.CLIPMUNK_FFMPEG ??= path.resolve("node_modules/ffmpeg-static/ffmpeg");
  // These operations remember the dev server and write snapshots; put the example back afterwards.
  for (const file of [".clipmunk/project.json", "src/clipmunk/scenes/rack-focus.scene.json"])
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
    const output = out(".clipmunk/exports/test-rack.mp4");
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
    const output = out(".clipmunk/exports/test-rack-workers.mp4");
    const result = await exportScene(
      { sceneId: "rack-focus", url, output, fps: 30, width: 500, height: 300, workers: 3, draft: true },
      { root },
    );
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.data.workers).toBe(3);
    expect(await probeVideo(output, root)).toMatchObject({ frames: 45, width: 500, height: 300 });
    expect(
      (await readdir(path.join(root, ".clipmunk/exports"))).filter((name) => name.startsWith(".clipmunk-export-")),
    ).toEqual([]);
  }, 240_000);

  it("publishes nothing when cancelled", async () => {
    const output = ".clipmunk/exports/test-cancelled.mp4";
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
        { sceneId: "rack-focus", url: "http://127.0.0.1:9", output: ".clipmunk/exports/never.mp4" },
        { root },
      ),
    ).toMatchObject({ ok: false, issues: [{ code: "server-unreachable" }] });
    const real = process.env.CLIPMUNK_FFMPEG;
    process.env.CLIPMUNK_FFMPEG = "/nonexistent/ffmpeg";
    try {
      expect(
        await exportScene(
          { sceneId: "rack-focus", url, output: ".clipmunk/exports/never.mp4", width: 500, height: 300, workers: 1 },
          { root },
        ),
      ).toMatchObject({ ok: false, issues: [{ code: "missing-ffmpeg" }] });
    } finally {
      process.env.CLIPMUNK_FFMPEG = real;
    }
    expect(existsSync(path.join(root, ".clipmunk/exports/never.mp4"))).toBe(false);
  }, 240_000);
});

describe("export jobs", () => {
  const exportsDir = path.join(root, ".clipmunk/exports");
  const listing = async () => (existsSync(exportsDir) ? await readdir(exportsDir) : []);

  it("makes an MP4, a GIF and a poster in one job, named after the clip, never overwriting", async () => {
    const before = await listing();
    const result = await exportJob(
      { clip: { kind: "scene", id: "rack-focus" }, url, formats: ["mp4", "gif", "poster"], size: "500x300", fps: 30 },
      { root },
    );
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    for (const item of result.data.outputs) out(item.output);
    const names = result.data.outputs.map((item) => item.output);
    const free = (name: string) => !before.includes(name.split("/").pop()!);
    expect(names.every(free)).toBe(true);
    expect(names.map((name) => path.extname(name))).toEqual([".mp4", ".gif", ".png"]);
    expect(names.every((name) => /^\.clipmunk\/exports\/rack-focus(-\d+)?\.(mp4|gif|png)$/.test(name))).toBe(true);
    const [mp4, gif, poster] = result.data.outputs;
    expect(mp4).toMatchObject({ format: "mp4", width: 500, height: 300, durationMs: 1500, fps: 30 });
    expect(await probeVideo(mp4!.output, root)).toMatchObject({ frames: 45, width: 500, height: 300 });
    expect(gif).toMatchObject({ format: "gif", fps: 15, width: 500, height: 300 });
    expect(gif!.bytes).toBeLessThan(5 * 1024 * 1024);
    expect((await readFile(path.join(root, gif!.output))).subarray(0, 6).toString("ascii")).toBe("GIF89a");
    const png = await readFile(path.join(root, poster!.output));
    expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([500, 300]);
    expect(poster).toMatchObject({ format: "poster", width: 500, height: 300 });
    // One manifest entry for the job, with every output and the scene's source files.
    const manifest = JSON.parse(await readFile(path.join(root, ".clipmunk/manifest.json"), "utf8"));
    const entry = manifest.clips["scene:rack-focus"];
    expect(entry.outputs).toEqual(names);
    expect(Object.keys(entry.files)).toEqual(
      expect.arrayContaining(["src/clipmunk/scenes/rack-focus.scene.json", "src/clipmunk/scenes/rack-focus.tsx"]),
    );
    expect(Object.values(entry.files).every((hash) => /^[0-9a-f]{64}$/.test(hash as string))).toBe(true);

    // The same job again gets new names beside the first ones.
    const again = await exportJob(
      { clip: { kind: "scene", id: "rack-focus" }, url, formats: ["poster"], size: "500x300", posterAtMs: 400 },
      { root },
    );
    if (!again.ok) throw new Error(JSON.stringify(again.issues));
    out(again.data.outputs[0]!.output);
    expect(again.data.outputs[0]!.output).not.toBe(poster!.output);
    expect(again.data.outputs[0]!.atMs).toBe(400);
  }, 240_000);

  it("steps a GIF down until it fits its size limit, and says what it chose", async () => {
    const result = await exportJob(
      {
        clip: { kind: "scene", id: "rack-focus" },
        url,
        formats: ["gif"],
        size: "500x300",
        fps: 30,
        gifMaxBytes: 60_000,
      },
      { root },
    );
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    const [gif] = result.data.outputs;
    out(gif!.output);
    expect(gif!.fps! < 15 || gif!.height < 300).toBe(true);
    expect(gif!.note).toMatch(/fps, \d+ px on the short side/);
    if (!/still over/.test(gif!.note!)) expect(gif!.bytes).toBeLessThanOrEqual(60_000);
  }, 240_000);

  it("publishes none of its outputs when cancelled, and explains what it cannot do", async () => {
    const before = await listing();
    const controller = new AbortController();
    const result = await exportJob(
      { clip: { kind: "scene", id: "rack-focus" }, url, formats: ["mp4", "gif", "poster"], size: "500x300", fps: 30 },
      { root, signal: controller.signal, onProgress: (done) => done >= 10 && controller.abort() },
    );
    expect(result).toMatchObject({ ok: false, issues: [{ code: "export-cancelled" }] });
    expect((await listing()).filter((name) => !before.includes(name))).toEqual([]);

    expect(
      await exportJob({ clip: { kind: "scene", id: "rack-focus" }, url, variants: ["sepia"] }, { root }),
    ).toMatchObject({ ok: false, issues: [{ code: "unknown-variant" }] });
    expect(await exportJob({ clip: { kind: "scene", id: "rack-focus" }, url, preset: "nope" }, { root })).toMatchObject(
      { ok: false, issues: [{ code: "unknown-preset" }] },
    );
    expect(
      await exportJob({ clip: { kind: "scene", id: "rack-focus" }, url, formats: ["webm"] }, { root }),
    ).toMatchObject({ ok: false, issues: [{ code: "invalid-export" }] });
  }, 240_000);
});

describe("scene variants", () => {
  it("renders light and dark in two shapes: four files with matching timing", async () => {
    const result = await exportJob(
      {
        clip: { kind: "scene", id: "themed-card" },
        url,
        variants: ["light", "dark"],
        ratios: ["16:9", "9:16"],
        fps: 30,
      },
      { root },
    );
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    for (const item of result.data.outputs) out(item.output);
    expect(result.data.outputs.map((item) => item.output)).toEqual([
      ".clipmunk/exports/themed-card.16x9.light.mp4",
      ".clipmunk/exports/themed-card.16x9.dark.mp4",
      ".clipmunk/exports/themed-card.9x16.light.mp4",
      ".clipmunk/exports/themed-card.9x16.dark.mp4",
    ]);
    const probes = await Promise.all(result.data.outputs.map((item) => probeVideo(item.output, root)));
    expect(probes.map((probe) => probe.frames)).toEqual([30, 30, 30, 30]);
    // 16:9 is not in the recipe, so the 400x300 scene is fitted into a 534x300 frame; 9:16 has its own size.
    expect(probes.map((probe) => `${probe.width}x${probe.height}`)).toEqual([
      "534x300",
      "534x300",
      "300x534",
      "300x534",
    ]);
    // The host's theme provider got the variant: the page behind the card is light in one and dark in the other.
    const page = (index: number, crop: string) =>
      colourAt(path.join(root, result.data.outputs[index]!.output), 0.5, crop);
    expect(near(page(0, "10:10:90:10"), [244, 244, 245], 12)).toBe(true);
    expect(near(page(1, "10:10:90:10"), [24, 24, 27], 12)).toBe(true);
    expect(near(page(2, "10:10:10:10"), [244, 244, 245], 12)).toBe(true);
    expect(near(page(3, "10:10:10:10"), [24, 24, 27], 12)).toBe(true);
  }, 300_000);
});

describe("frame page", () => {
  it("captures every scene byte for byte the same each time it is opened", async () => {
    const listed = await listScenes({ root });
    if (!listed.ok) throw new Error(JSON.stringify(listed.issues));
    const browser = await launchBrowser();
    try {
      for (const scene of listed.data.scenes) {
        const { width, height } = scene.definition;
        const viewport = { width: Math.round(width), height: Math.round(height) };
        // Two separate pages: the frame page must not depend on what ran before (the old in-app
        // studio page, which it replaced, was checked against it the same way in PR 11).
        const studio = await openClip(browser, `${url}/?clipmunk-frame=1&clipmunk-scene=${scene.id}`, viewport);
        const frame = await openClip(browser, `${url}/?clipmunk-frame=1&clipmunk-scene=${scene.id}`, viewport);
        try {
          expect(frame.info, scene.id).toEqual(studio.info);
          const duration = studio.info.durationMs;
          for (const at of [0, duration / 2, duration]) {
            const [a, b] = [await studio.frame(at, "png"), await frame.frame(at, "png")];
            expect(b.equals(a), `${scene.id} at ${at} ms`).toBe(true);
          }
        } finally {
          await studio.close();
          await frame.close();
        }
      }
    } finally {
      await browser.close();
    }
  }, 600_000);
});

describe("snapshot", () => {
  it("stores a small PNG of the chosen frame in the recipe", async () => {
    const result = await snapshotScene({ sceneId: "rack-focus", url, timeMs: 400 }, { root });
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.data).toMatchObject({
      sceneId: "rack-focus",
      source: "src/clipmunk/scenes/rack-focus.scene.json",
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
