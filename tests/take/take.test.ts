import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Browser, chromium, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "../../src/cli/run";
import { type Daemon, startDaemon } from "../../src/daemon";
import { exportTake, probeMedia, probeVideo } from "../../src/export";
import { colourAt, near } from "../support/media";
import { FFMPEG, makeTake, QUADRANTS } from "../support/take";

/** The take compositor, editor and export, checked against a synthetic take whose pixels are known. */
const root = path.resolve("examples/vite-app");
const IDS = ["zz-test-edit", "zz-test-export", "zz-test-zoom"];
const made: string[] = [];
let server: ViteDevServer, daemon: Daemon, browser: Browser, page: Page, origin: string, projectFile: string;

// Canvas geometry for the default edit: 1920x1080, 6% padding, a 640x360 source.
const SCALE = 2.64,
  BOX = { x: 115.2, y: 64.8 };
const at = (x: number, y: number) => [BOX.x + x * SCALE, BOX.y + y * SCALE] as const;
const CAM = [1787, 947] as const;
const pixel = (x: number, y: number) =>
  page.evaluate(
    ([px, py]) => {
      const canvas = document.querySelector("[data-clipmunk-chrome]")!.shadowRoot!.querySelector("canvas")!;
      return [...canvas.getContext("2d")!.getImageData(Math.round(px!), Math.round(py!), 1, 1).data.slice(0, 3)];
    },
    [x, y],
  );
const seek = (ms: number) => page.evaluate((time) => (window as any).__CLIPMUNK__.seek(time), ms);
const takeFile = (id: string) => path.join(root, ".clipmunk/takes", id, "take.json");

beforeAll(async () => {
  process.env.CLIPMUNK_FFMPEG ??= FFMPEG;
  projectFile = await readFile(path.join(root, ".clipmunk/project.json"), "utf8");
  for (const id of IDS) await makeTake(root, id);
  server = await createServer({ root, server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
  await server.listen();
  origin = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`;
  daemon = await startDaemon({ root, port: 0, announce: false });
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (error) => console.error("pageerror:", error.message));
  await page.goto(`${origin}/?clipmunk=1&clipmunk-take=zz-test-edit#clipmunk-daemon=${daemon.port}.${daemon.token}`);
  await page.waitForFunction(() => (window as any).__CLIPMUNK__?.kind === "take", undefined, { timeout: 45_000 });
}, 120_000);
afterAll(async () => {
  await browser?.close();
  await daemon?.close();
  await server?.close();
  for (const id of IDS) await rm(path.join(root, ".clipmunk/takes", id), { recursive: true, force: true });
  for (const file of made) await rm(path.join(root, file), { force: true });
  await writeFile(path.join(root, ".clipmunk/project.json"), projectFile);
});

describe("take compositor", () => {
  it("lays the recording on the canvas with the camera bubble in its corner", async () => {
    await seek(300);
    expect(near(await pixel(5, 5), [11, 11, 15], 6), "canvas background").toBe(true);
    expect(near(await pixel(...at(160, 90)), QUADRANTS.red)).toBe(true);
    expect(near(await pixel(...at(480, 90)), QUADRANTS.green)).toBe(true);
    expect(near(await pixel(...at(160, 270)), QUADRANTS.blue)).toBe(true);
    expect(near(await pixel(...at(480, 270)), QUADRANTS.yellow)).toBe(true);
    expect(near(await pixel(...CAM), [255, 0, 255]), "camera bubble").toBe(true);
    // The bubble is a circle: its bounding square's corner still shows what is behind it.
    expect(near(await pixel(CAM[0] + 90, CAM[1] + 90), [255, 0, 255])).toBe(false);
  });

  it("zooms to the click, with the click at the centre and the cursor drawn on it", async () => {
    await seek(2000);
    // The yellow quadrant now fills the frame, including where red and green were.
    for (const [x, y] of [
      [160, 90],
      [480, 90],
      [160, 270],
      [600, 40],
    ] as const)
      expect(near(await pixel(...at(x, y)), QUADRANTS.yellow), `${x},${y}`).toBe(true);
    // The click point is at the centre of the canvas; the cursor's body sits just below its tip.
    expect(near(await pixel(960, 560), [255, 255, 255], 25), "cursor").toBe(true);
    await seek(3900); // after the hold, the view has eased back out
    expect(near(await pixel(...at(160, 90)), QUADRANTS.red)).toBe(true);
  });

  it("draws nothing for the cursor before the pointer first moves", async () => {
    await seek(300);
    const first = at(100, 80);
    expect(near(await pixel(first[0] + 4, first[1] + 12), QUADRANTS.red)).toBe(true);
    await seek(700);
    expect(near(await pixel(...at(160, 90)), QUADRANTS.red)).toBe(true);
  });
});

describe("take editor", () => {
  const toggle = (label: string) => page.getByLabel(label, { exact: true }).click();
  const saved = async (read: (edit: any) => unknown, expected: unknown) =>
    expect
      .poll(async () => read(JSON.parse(await readFile(takeFile("zz-test-edit"), "utf8")).edit), { timeout: 10_000 })
      .toEqual(expected);

  it("applies edits to the preview at once and saves them to take.json", async () => {
    await seek(2000);
    await toggle("Show cursor");
    await expect.poll(() => pixel(960, 560).then((value) => near(value, QUADRANTS.yellow))).toBe(true);
    await saved((edit) => edit.cursor.visible, false);
    await toggle("Show cursor");

    await toggle("Show camera");
    await expect.poll(() => pixel(...CAM).then((value) => near(value, [255, 0, 255]))).toBe(false);
    await saved((edit) => edit.cam.visible, false);
    await toggle("Show camera");
    await page.locator('label.field:has-text("Corner") select').selectOption("tl");
    await expect.poll(() => pixel(1920 - CAM[0], 1080 - CAM[1]).then((value) => near(value, [255, 0, 255]))).toBe(true);
    await saved((edit) => edit.cam.corner, "tl");

    await page.getByLabel("Mode").selectOption("off");
    await expect.poll(() => pixel(...at(160, 90)).then((value) => near(value, QUADRANTS.red))).toBe(true);
    await saved((edit) => edit.zoom, { mode: "off" });
    expect(await page.locator(".timeline .zoom").count()).toBe(0);
    await page.getByLabel("Mode").selectOption("auto");
    await expect.poll(() => page.locator(".timeline .zoom").count()).toBe(1);
  }, 60_000);

  it("adds generated music, picks a new tune, and plays it with the preview", async () => {
    await page
      .locator("label.field", { hasText: /^Music/ })
      .locator("select")
      .selectOption("lofi");
    await saved((edit) => edit.music, { style: "lofi", gain: 0.5, duck: true, sync: true }); // its own tune, from the take's name
    expect(await page.getByLabel(/Sync the beat to 1 moment/).isChecked()).toBe(true); // the take has one click
    await page.getByRole("button", { name: "New tune" }).click();
    await expect
      .poll(async () => typeof JSON.parse(await readFile(takeFile("zz-test-edit"), "utf8")).edit.music.seed, {
        timeout: 10_000,
      })
      .toBe("number");
    // Playing with music on must not disturb playback.
    await seek(0);
    await page.getByRole("button", { name: "Play" }).click();
    await page.waitForTimeout(600);
    await page.getByRole("button", { name: "Pause" }).click();
    expect(await page.locator(".transport .time").textContent()).not.toMatch(/^0\.00s/);
    await page.getByRole("button", { name: "Listen" }).click();
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await page
      .locator("label.field", { hasText: /^Music/ })
      .locator("select")
      .selectOption("off");
    await expect
      .poll(async () => "music" in JSON.parse(await readFile(takeFile("zz-test-edit"), "utf8")).edit, {
        timeout: 10_000,
      })
      .toBe(false);
  }, 60_000);

  it("plays, and trims from the playhead", async () => {
    await seek(0);
    await page.getByRole("button", { name: "Play" }).click();
    await page.waitForTimeout(700);
    await page.getByRole("button", { name: "Pause" }).click();
    expect(await page.locator(".transport .time").textContent()).not.toMatch(/^0\.00s/);
    await seek(1000);
    await page.getByRole("button", { name: "Start here" }).click();
    await expect.poll(() => page.locator(".transport .time").textContent()).toBe("0.00s / 3.00s");
    await seek(2000);
    await page.getByRole("button", { name: "End here" }).click();
    await saved((edit) => edit.trim, { startMs: 1000, endMs: 3000 });
    // Clip time 1000 is now take time 2000: the zoomed moment.
    await seek(1000);
    expect(near(await pixel(...at(160, 90)), QUADRANTS.yellow)).toBe(true);
  }, 60_000);
});

describe("exporting from the editor", () => {
  it("offers resolutions in the clip's own shape and renders the chosen one through the daemon", async () => {
    await page.getByRole("button", { name: "Export" }).click();
    const options = await page.getByLabel("Resolution").locator("option").allTextContents();
    expect(options).toEqual(["Original · 1920×1080", "720p · 1280×720", "1440p · 2560×1440", "4K · 3840×2160"]);
    await page.getByLabel("Resolution").selectOption("720p");
    await page.getByLabel("Frame rate").selectOption("30");
    await page.getByRole("button", { name: "Render", exact: true }).click();
    await page.locator(".command code", { hasText: "Wrote" }).waitFor({ timeout: 180_000 });
    const output = (await page.locator(".command code").textContent())!.match(/Wrote (\S+)/)![1]!;
    made.push(output);
    expect(output).toBe(".clipmunk/exports/zz-test-edit.mp4");
    // The editor's trim (1.0 s to 3.0 s, set above) and the chosen size both reach the file.
    expect(await probeVideo(output, root)).toMatchObject({ width: 1280, height: 720, fps: 30, frames: 60 });
  }, 240_000);
});

describe("take export", () => {
  const colour = (file: string, at: number, crop: string) => colourAt(path.join(root, file), at, crop);

  it("renders the composited take to an MP4 with the voice track", async () => {
    const output = ".clipmunk/exports/zz-test-take.mp4";
    made.push(output);
    const progress: number[] = [];
    const result = await exportTake(
      { takeId: "zz-test-export", url: origin, output, fps: 30, height: 360 },
      { root, onProgress: (done) => progress.push(done) },
    );
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.data).toMatchObject({
      output,
      fps: 30,
      frames: 120,
      durationMs: 4000,
      width: 640,
      height: 360,
      audio: true,
    });
    expect(progress.at(-1)).toBe(120);
    expect(await probeVideo(output, root)).toMatchObject({ frames: 120, width: 640, height: 360, fps: 30 });
    expect(await probeMedia(output, root)).toMatchObject({ hasVideo: true, hasAudio: true, durationMs: 4000 });
    // Same picture as the editor, at a third of the size: unzoomed at 0.3 s, zoomed into yellow at 2 s.
    expect(near(colour(output, 0.3, "20:20:170:95"), QUADRANTS.red, 50)).toBe(true);
    expect(near(colour(output, 2.0, "20:20:170:95"), QUADRANTS.yellow, 50)).toBe(true);
    expect(near(colour(output, 2.0, "8:8:2:2"), [11, 11, 15], 12)).toBe(true);
    expect(near(colour(output, 2.0, "16:16:588:308"), [255, 0, 255], 50), "camera bubble").toBe(true);
    expect(await exportTake({ takeId: "zz-test-export", url: origin, output, fps: 30 }, { root })).toMatchObject({
      ok: false,
      issues: [{ code: "output-exists" }],
    });
  }, 240_000);

  it("puts generated music under the voice", async () => {
    const file = takeFile("zz-test-export");
    const take = JSON.parse(await readFile(file, "utf8"));
    await writeFile(
      file,
      JSON.stringify({
        ...take,
        edit: { ...take.edit, music: { style: "lofi" }, audio: { ...take.edit.audio, muted: true } },
      }),
    );
    const musicOnly = ".clipmunk/exports/zz-test-take-music.mp4";
    made.push(musicOnly);
    const result = await exportTake(
      { takeId: "zz-test-export", url: origin, output: musicOnly, fps: 30, height: 360 },
      { root },
    );
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    // The voice is muted, so any sound in the file is the music.
    expect(result.data.audio).toBe(true);
    expect(await probeMedia(musicOnly, root)).toMatchObject({ hasAudio: true, durationMs: 4000 });

    await writeFile(file, JSON.stringify({ ...take, edit: { ...take.edit, music: { style: "lofi" } } }));
    const both = ".clipmunk/exports/zz-test-take-music-voice.mp4";
    made.push(both);
    const mixed = await exportTake(
      { takeId: "zz-test-export", url: origin, output: both, fps: 30, height: 360 },
      { root },
    );
    expect(mixed.ok && mixed.data.audio).toBe(true);
    const off = await exportTake(
      {
        takeId: "zz-test-export",
        url: origin,
        output: ".clipmunk/exports/zz-test-take-nomusic.mp4",
        fps: 30,
        height: 360,
        music: false,
      },
      { root },
    );
    made.push(".clipmunk/exports/zz-test-take-nomusic.mp4");
    expect(off.ok && off.data.audio).toBe(true); // the voice alone
    await writeFile(file, JSON.stringify(take));
  }, 400_000);

  it("honours trim and mute, and explains what it cannot do", async () => {
    const file = takeFile("zz-test-export");
    const take = JSON.parse(await readFile(file, "utf8"));
    take.edit.trim = { startMs: 1500, endMs: 2500 };
    take.edit.audio.muted = true;
    await writeFile(file, JSON.stringify(take));
    const output = ".clipmunk/exports/zz-test-take-trim.mp4";
    made.push(output);
    const result = await exportTake({ takeId: "zz-test-export", url: origin, output, fps: 30, height: 360 }, { root });
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.data).toMatchObject({ frames: 30, durationMs: 1000, audio: false });
    expect(await probeMedia(output, root)).toMatchObject({ hasAudio: false, durationMs: 1000 });
    expect(near(colour(output, 0.5, "20:20:170:95"), QUADRANTS.yellow, 50)).toBe(true); // clip 0.5 s is take 2.0 s
    expect(await exportTake({ takeId: "nope", url: origin }, { root })).toMatchObject({
      ok: false,
      issues: [{ code: "unknown-take" }],
    });
    expect(await exportTake({ takeId: "zz-test-export", url: origin, fps: 24 }, { root })).toMatchObject({
      ok: false,
      issues: [{ code: "invalid-export" }],
    });
    expect(existsSync(path.join(root, ".clipmunk/exports/nope.mp4"))).toBe(false);
  }, 240_000);
});

describe("clipmunk zoom", () => {
  const clipmunk = async (...args: string[]) => {
    const out: string[] = [];
    const code = await run(args, {
      cwd: root,
      out: (text) => out.push(text),
      err: (text) => out.push(text),
      version: "test",
    });
    return { code, out: out.join("\n") };
  };
  it("shows the automatic zooms and stores them as editable keyframes", async () => {
    const shown = JSON.parse((await clipmunk("zoom", "zz-test-zoom", "--json")).out);
    expect(shown.data.mode).toBe("auto");
    expect(shown.data.segments).toEqual([{ startMs: 1000, endMs: 4000, scale: 2.2 }]);
    expect((await clipmunk("zoom", "zz-test-zoom")).out).toContain("1.00s to 4.00s  at 2.20x");
    expect((await clipmunk("zoom", "zz-test-zoom", "--write")).out).toContain("Stored 1 zoom as manual keyframes");
    const edit = JSON.parse(await readFile(takeFile("zz-test-zoom"), "utf8")).edit;
    expect(edit.zoom.mode).toBe("manual");
    expect(edit.zoom.tracks.map((track: { property: string }) => track.property)).toEqual(["x", "y", "scale"]);
    expect(JSON.parse((await clipmunk("zoom", "zz-test-zoom", "--json")).out).data.mode).toBe("manual");
    expect((await clipmunk("zoom", "nope")).code).toBe(1);
  });
});
