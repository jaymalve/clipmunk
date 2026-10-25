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
import { FFMPEG, makeTake, QUADRANTS, SECRET, secretTop } from "../support/take";

/** The take compositor, editor and export, checked against a synthetic take whose pixels are known. */
const root = path.resolve("examples/vite-app");
const IDS = ["zz-test-edit", "zz-test-export", "zz-test-zoom"];
const SECRETS = { "zz-test-redact": "redacted", "zz-test-plain": "visible" } as const;
const NAMED = "zz-test-captions";
const REFRAMED = "zz-test-reframe";
const PACED = { "zz-test-paced": false, "zz-test-paced-voice": true } as const;
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
// Every change is saved to edit.json; take.json is the recording and must never change.
const editFile = (id: string) => path.join(root, ".clipmunk/takes", id, "edit.json");
const recordFile = (id: string) => path.join(root, ".clipmunk/takes", id, "take.json");

beforeAll(async () => {
  process.env.CLIPMUNK_FFMPEG ??= FFMPEG;
  projectFile = await readFile(path.join(root, ".clipmunk/project.json"), "utf8");
  for (const id of IDS) await makeTake(root, id);
  for (const [id, secret] of Object.entries(SECRETS)) await makeTake(root, id, { secret, cam: false });
  await makeTake(root, NAMED, { named: true, cam: false });
  for (const [id, cam] of Object.entries(PACED)) await makeTake(root, id, { paced: true, cam });
  await makeTake(root, REFRAMED, { cam: false });
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
  for (const id of [...IDS, ...Object.keys(SECRETS), NAMED, ...Object.keys(PACED), REFRAMED])
    await rm(path.join(root, ".clipmunk/takes", id), { recursive: true, force: true });
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
      .poll(async () => read(JSON.parse(await readFile(editFile("zz-test-edit"), "utf8")).edit), { timeout: 10_000 })
      .toEqual(expected);

  it("applies edits to the preview at once and saves them to edit.json", async () => {
    const record = await readFile(recordFile("zz-test-edit"), "utf8");
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
    expect(await readFile(recordFile("zz-test-edit"), "utf8")).toBe(record);
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
      .poll(async () => typeof JSON.parse(await readFile(editFile("zz-test-edit"), "utf8")).edit.music.seed, {
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
      .poll(async () => "music" in JSON.parse(await readFile(editFile("zz-test-edit"), "utf8")).edit, {
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

describe("redaction", () => {
  // The middle of a white stripe of the secret box, in canvas pixels, at a time on the take clock.
  const stripe = (ms: number) => at(SECRET.x + 4.5 * SECRET.stripe, secretTop(ms) + SECRET.height / 2);
  const WHITE = [255, 255, 255],
    BLACK = [0, 0, 0];
  // Before, at the start of, during, at the end of and after the scroll.
  const TIMES = [500, 1000, 1100, 1250, 1400, 1500, 1700, 2500];
  const hidden = (colour: number[]) => !near(colour, WHITE, 60) && !near(colour, BLACK, 60);
  const open = async (id: string) => {
    const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await tab.goto(`${origin}/?clipmunk=1&clipmunk-take=${id}#clipmunk-daemon=${daemon.port}.${daemon.token}`);
    await tab.waitForFunction(() => (window as any).__CLIPMUNK__?.kind === "take", undefined, { timeout: 45_000 });
    const pixelAt = async (ms: number, [x, y]: readonly [number, number]) => {
      await tab.evaluate((time) => (window as any).__CLIPMUNK__.seek(time), ms);
      return tab.evaluate(
        ([px, py]) => {
          const canvas = document.querySelector("[data-clipmunk-chrome]")!.shadowRoot!.querySelector("canvas")!;
          return [...canvas.getContext("2d")!.getImageData(Math.round(px!), Math.round(py!), 1, 1).data.slice(0, 3)];
        },
        [x, y],
      );
    };
    return { tab, pixelAt };
  };

  it("blurs or blocks a scrolling element in every frame of the preview", async () => {
    const plain = await open("zz-test-plain");
    try {
      // Without redaction the stripe shows, so the checks below look at the secret itself.
      for (const ms of [500, 1250, 2500])
        expect(near(await plain.pixelAt(ms, stripe(ms)), WHITE, 40), `${ms}`).toBe(true);
    } finally {
      await plain.tab.close();
    }
    const { tab, pixelAt } = await open("zz-test-redact");
    try {
      for (const ms of TIMES) expect(hidden(await pixelAt(ms, stripe(ms))), `blurred at ${ms}`).toBe(true);
      // Next to the box, the recording is untouched.
      expect(near(await pixelAt(2500, at(300, 40)), QUADRANTS.red)).toBe(true);
      const mode = tab.locator(`label.field:has-text("${SECRET.sel}") select`);
      const saved = (expected: string) =>
        expect
          .poll(async () => JSON.parse(await readFile(editFile("zz-test-redact"), "utf8")).edit.redact[0].mode, {
            timeout: 10_000,
          })
          .toBe(expected);
      await mode.selectOption("block");
      await saved("block");
      for (const ms of TIMES)
        expect(near(await pixelAt(ms, stripe(ms)), [28, 28, 33], 8), `blocked at ${ms}`).toBe(true);
      await mode.selectOption("blur");
      await saved("blur");
    } finally {
      await tab.close();
    }
  }, 120_000);

  it("keeps it hidden in the exported MP4", async () => {
    const output = ".clipmunk/exports/zz-test-redact.mp4";
    made.push(output);
    const result = await exportTake({ takeId: "zz-test-redact", url: origin, output, fps: 30, height: 1080 }, { root });
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    const file = path.join(root, output);
    for (const ms of TIMES) {
      const [x, y] = stripe(ms);
      expect(hidden(colourAt(file, ms / 1000, `6:6:${Math.round(x - 3)}:${Math.round(y - 3)}`)), `${ms}`).toBe(true);
    }
  }, 240_000);
});

describe("captions and shortcuts", () => {
  // Inside the caption strip, above its text, and inside the key pill above it (default 16:9 canvas).
  const CAPTION = [900, 930] as const,
    PILL = [960, 856] as const;
  const DARK = [11, 11, 15];

  it("captions the named click and shows ⌘K as a pill, and both can be turned off", async () => {
    const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await tab.goto(`${origin}/?clipmunk=1&clipmunk-take=${NAMED}#clipmunk-daemon=${daemon.port}.${daemon.token}`);
      await tab.waitForFunction(() => (window as any).__CLIPMUNK__?.kind === "take", undefined, { timeout: 45_000 });
      const pixelAt = async (ms: number, [x, y]: readonly [number, number]) => {
        await tab.evaluate((time) => (window as any).__CLIPMUNK__.seek(time), ms);
        return tab.evaluate(
          ([px, py]) => {
            const canvas = document.querySelector("[data-clipmunk-chrome]")!.shadowRoot!.querySelector("canvas")!;
            return [...canvas.getContext("2d")!.getImageData(px!, py!, 1, 1).data.slice(0, 3)];
          },
          [x, y],
        );
      };
      const saved = (read: (edit: any) => unknown, expected: unknown) =>
        expect
          .poll(async () => read(JSON.parse(await readFile(editFile(NAMED), "utf8")).edit), { timeout: 10_000 })
          .toEqual(expected);

      expect(near(await pixelAt(500, CAPTION), DARK, 45), "no caption before the click").toBe(false);
      expect(near(await pixelAt(2000, CAPTION), DARK, 45), "caption at the click").toBe(true);
      expect(near(await pixelAt(2000, PILL), DARK, 45), "no pill before the shortcut").toBe(false);
      expect(near(await pixelAt(3100, PILL), DARK, 45), "pill for ⌘K").toBe(true);
      expect(near(await pixelAt(3100 + 900, PILL), DARK, 45), "the pill has gone").toBe(false);

      // The caption's text is listed and editable; an edit is kept as a manual caption.
      const field = tab.getByLabel("Caption at 1.7s");
      await expect.poll(() => field.inputValue()).toBe("Click Go");
      await field.fill("Press Go");
      await saved((edit) => edit.captions.items, [{ atMs: 1700, durMs: 1800, text: "Press Go", source: "manual" }]);

      await tab.getByLabel("Show shortcuts", { exact: true }).click();
      await saved((edit) => edit.keys.visible, false);
      expect(near(await pixelAt(3100, PILL), DARK, 45), "shortcuts off").toBe(false);
      await tab.getByLabel("Automatic captions", { exact: true }).click();
      await saved((edit) => edit.captions.auto, false);
      // With automatic captions off the stored items still show, so clear the edited one too.
      expect(near(await pixelAt(2000, CAPTION), DARK, 45), "manual caption stays").toBe(true);
      await field.fill("");
      await saved((edit) => edit.captions.items[0].text, "");
      expect(near(await pixelAt(2000, CAPTION), DARK, 45), "cleared").toBe(false);
      // Back to the defaults, for the export below.
      await tab.getByLabel("Automatic captions", { exact: true }).click();
      await tab.getByLabel("Show shortcuts", { exact: true }).click();
      await saved((edit) => [edit.captions.auto, edit.keys.visible], [true, true]);
      await field.fill("Press Go");
      await saved((edit) => edit.captions.items[0].text, "Press Go");
    } finally {
      await tab.close();
    }
  }, 120_000);

  it("exports them into the MP4", async () => {
    const output = ".clipmunk/exports/zz-test-captions.mp4";
    made.push(output);
    const result = await exportTake({ takeId: NAMED, url: origin, output, fps: 30 }, { root });
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    const file = path.join(root, output);
    const at = (seconds: number, [x, y]: readonly [number, number]) => colourAt(file, seconds, `4:4:${x - 2}:${y - 2}`);
    expect(near(at(2.0, CAPTION), DARK, 50), "caption").toBe(true);
    expect(near(at(0.5, CAPTION), DARK, 50), "no caption yet").toBe(false);
    expect(near(at(3.1, PILL), DARK, 50), "pill above the caption").toBe(true);
    expect(near(at(2.0, PILL), DARK, 50), "no pill yet").toBe(false);
  }, 240_000);
});

describe("pacing", () => {
  it("exports idle time fast, and keeps a take whose voice never stops as it is", async () => {
    // The synthetic take's input runs from 600 to 2090 ms of 4000. With a 600 ms allowed gap at 4x,
    // 0-300 and 2390-4000 play fast: 1910 ms of idle time take a quarter as long.
    const expected = 4000 - 1910 * 0.75;
    const output = ".clipmunk/exports/zz-test-paced.mp4";
    made.push(output);
    const result = await exportTake({ takeId: "zz-test-paced", url: origin, output, fps: 30, height: 360 }, { root });
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.data.frames).toBe(Math.ceil((expected * 30) / 1000));
    expect(await probeVideo(output, root)).toMatchObject({ frames: Math.ceil((expected * 30) / 1000) });
    // The click (2000 ms of take time, 2000 - 225 of clip time) is still zoomed into yellow.
    expect(near(colourAt(path.join(root, output), (2000 - 225) / 1000, "20:20:170:95"), QUADRANTS.yellow, 50)).toBe(
      true,
    );

    // The camera's tone is a voice that never stops, so nothing is sped up, and its sound is all there.
    const voiced = ".clipmunk/exports/zz-test-paced-voice.mp4";
    made.push(voiced);
    const kept = await exportTake(
      { takeId: "zz-test-paced-voice", url: origin, output: voiced, fps: 30, height: 360 },
      { root },
    );
    if (!kept.ok) throw new Error(JSON.stringify(kept.issues));
    expect(kept.data).toMatchObject({ frames: 120, durationMs: 4000, audio: true });
    expect(existsSync(path.join(root, ".clipmunk/takes/zz-test-paced-voice/speech.json"))).toBe(true);
  }, 240_000);

  it("turns off per take in the editor", async () => {
    const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await tab.goto(
        `${origin}/?clipmunk=1&clipmunk-take=zz-test-paced#clipmunk-daemon=${daemon.port}.${daemon.token}`,
      );
      await tab.waitForFunction(() => (window as any).__CLIPMUNK__?.kind === "take", undefined, { timeout: 45_000 });
      const duration = () => tab.evaluate(() => (window as any).__CLIPMUNK__.durationMs as number);
      expect(await duration()).toBe(4000 - 1910 * 0.75);
      await tab.getByLabel("Speed up idle time (4×)", { exact: true }).click();
      await expect.poll(duration).toBe(4000);
      await expect
        .poll(async () => JSON.parse(await readFile(editFile("zz-test-paced"), "utf8")).edit.pace.deadAir.on, {
          timeout: 10_000,
        })
        .toBe(false);
    } finally {
      await tab.close();
    }
  }, 120_000);
});

describe("reframing", () => {
  it("crops a 9:16 frame to the clicked element, with the click inside it", async () => {
    const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await tab.goto(`${origin}/?clipmunk=1&clipmunk-take=${REFRAMED}#clipmunk-daemon=${daemon.port}.${daemon.token}`);
      await tab.waitForFunction(() => (window as any).__CLIPMUNK__?.kind === "take", undefined, { timeout: 45_000 });
      const pixelAt = async (ms: number, x: number, y: number) => {
        await tab.evaluate((time) => (window as any).__CLIPMUNK__.seek(time), ms);
        return tab.evaluate(
          ([px, py]) => {
            const canvas = document.querySelector("[data-clipmunk-chrome]")!.shadowRoot!.querySelector("canvas")!;
            return [...canvas.getContext("2d")!.getImageData(px!, py!, 1, 1).data.slice(0, 3)];
          },
          [x, y],
        );
      };
      await tab.getByLabel("Shape").selectOption("9:16");
      await expect
        .poll(async () => JSON.parse(await readFile(editFile(REFRAMED), "utf8")).edit, { timeout: 10_000 })
        .toMatchObject({ frame: { ratio: "9:16" }, canvas: { width: 1080, height: 1920 } });
      // 1080x1920 with 6% padding: a 950.4x1790.4 box, so a 191-pixel-wide crop of the 640x360 recording,
      // centred on the button clicked at x = 480. Before any zoom, the crop shows only green over yellow.
      const scale = 1790.4 / 360,
        top = 64.8;
      const left = 480 - (360 * (950.4 / 1790.4)) / 2;
      const at = (x: number, y: number) =>
        [Math.round(64.8 + (x - left) * scale), Math.round(top + y * scale)] as const;
      await expect
        .poll(() => pixelAt(300, ...at(left + 5, 90)).then((value) => near(value, QUADRANTS.green)))
        .toBe(true);
      expect(near(await pixelAt(300, ...at(left + 186, 90)), QUADRANTS.green)).toBe(true);
      expect(near(await pixelAt(300, ...at(left + 5, 270)), QUADRANTS.yellow)).toBe(true);
      expect(near(await pixelAt(300, ...at(480, 270)), QUADRANTS.yellow)).toBe(true);
      // Red and blue are cropped out entirely.
      for (const [x, y] of [at(left + 5, 90), at(left + 5, 270)])
        for (const colour of [QUADRANTS.red, QUADRANTS.blue])
          expect(near(await pixelAt(300, x, y), colour)).toBe(false);
      // Back to fitting the whole recording.
      await tab.getByLabel("Shape").selectOption("4:3");
      await expect
        .poll(async () => JSON.parse(await readFile(editFile(REFRAMED), "utf8")).edit.frame, { timeout: 10_000 })
        .toBeUndefined();
    } finally {
      await tab.close();
    }
  }, 120_000);
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
    const file = editFile("zz-test-export");
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
    const file = editFile("zz-test-export");
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
    const edit = JSON.parse(await readFile(editFile("zz-test-zoom"), "utf8")).edit;
    expect(edit.zoom.mode).toBe("manual");
    expect(edit.zoom.tracks.map((track: { property: string }) => track.property)).toEqual(["x", "y", "scale"]);
    expect(JSON.parse((await clipmunk("zoom", "zz-test-zoom", "--json")).out).data.mode).toBe("manual");
    expect((await clipmunk("zoom", "nope")).code).toBe(1);
  });
});
