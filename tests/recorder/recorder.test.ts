import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keyPills, reframePath, resolveCaptions, type Take, type TakeEvent, TakeEventSchema } from "../../src/core";
import { type Daemon, startDaemon } from "../../src/daemon";
import { exportTake, probeMedia, probeVideo } from "../../src/export";
import { colourAt } from "../support/media";
import { readTakeFiles } from "../support/take";

/** Records the example app for real: headed Chromium capturing its own tab, the HUD,
 * the event log, chunked upload to the daemon and ingest. Needs a display (xvfb-run).
 */
const root = path.resolve("examples/vite-app");
const ffmpeg = path.resolve("node_modules/ffmpeg-static/ffmpeg");
let server: ViteDevServer, daemon: Daemon, browser: Browser, context: BrowserContext, page: Page, origin: string;
const takes: string[] = [];
let withCamera = "";
let projectFile = "";
const hud = () => page.locator("clipmunk-recorder");
/** Wait for the recorder to be recording; on failure, report what the HUD says instead of a bare timeout. */
async function recording() {
  await hud()
    .locator("button.action", { hasText: "Stop" })
    .waitFor({ timeout: 20_000 })
    .catch(async () => {
      throw new Error(
        `Recording did not start. HUD says: "${await hud().locator(".status").textContent()}" / button "${await hud().locator("button.action").textContent()}"`,
      );
    });
}

async function record(
  options: { camera: boolean; microphone: boolean },
  during: () => Promise<void>,
): Promise<{ take: Take; events: TakeEvent[]; dir: string }> {
  for (const [name, wanted] of [
    ["mic", options.microphone],
    ["camera", options.camera],
  ] as const) {
    const button = hud().locator(`button.${name}`);
    if ((await button.getAttribute("aria-pressed")) !== String(wanted)) await button.click();
  }
  await hud().locator("button.action").click();
  await recording();
  await during();
  await hud().locator("button.action").click();
  await hud().locator(".status a").waitFor({ timeout: 30_000 });
  const id = new URL((await hud().locator(".status a").getAttribute("href"))!, origin).searchParams.get(
    "clipmunk-take",
  )!;
  takes.push(id);
  const dir = path.join(root, ".clipmunk/takes", id);
  const take = await readTakeFiles(dir);
  if (!take.ok) throw new Error(JSON.stringify(take.issues));
  const events = (await readFile(path.join(dir, "events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => TakeEventSchema.parse(JSON.parse(line)));
  return { take: take.data, events, dir };
}

beforeAll(async () => {
  process.env.CLIPMUNK_FFMPEG ??= ffmpeg;
  projectFile = await readFile(path.join(root, ".clipmunk/project.json"), "utf8"); // exporting remembers the dev server; put it back
  server = await createServer({ root, server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
  await server.listen();
  origin = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`;
  daemon = await startDaemon({ root, port: 0, announce: false }); // the example may have a real daemon running
  browser = await chromium.launch({
    headless: false,
    args: ["--auto-accept-this-tab-capture", "--use-fake-device-for-media-stream", "--window-size=1300,900"],
  });
  context = await browser.newContext({ viewport: null, permissions: ["camera", "microphone"] });
  page = await context.newPage();
  page.on("pageerror", (error) => console.error("pageerror:", error.message));
  await page.goto(`${origin}/?clipmunk-record=1#clipmunk-daemon=${daemon.port}.${daemon.token}`);
  await hud().locator(".status", { hasText: "Ready" }).waitFor({ timeout: 20_000 });
}, 90_000);
afterAll(async () => {
  await browser?.close();
  await daemon?.close();
  await server?.close();
  for (const id of takes) await rm(path.join(root, ".clipmunk/takes", id), { recursive: true, force: true });
  await writeFile(path.join(root, ".clipmunk/project.json"), projectFile);
});

describe("recorder", () => {
  it("connects from the daemon link, hides the token, and mounts its HUD outside <body>", async () => {
    expect(new URL(page.url()).hash).toBe("");
    expect(
      await page.evaluate(
        () => document.querySelector("clipmunk-recorder")!.parentElement === document.documentElement,
      ),
    ).toBe(true);
    expect(await page.evaluate(() => document.body.contains(document.querySelector("clipmunk-recorder")))).toBe(false);
  });

  it("records the tab without the HUD or cursor and logs interactions without their content", async () => {
    const button = page.getByRole("button", { name: "New report" });
    const box = (await button.boundingBox())!;
    let recordedFor = 0;
    const { take, events, dir } = await record({ camera: false, microphone: false }, async () => {
      const started = Date.now();
      // The page is prepared for capture only while recording.
      expect(
        await page.evaluate(() => [
          getComputedStyle(document.body).cursor,
          getComputedStyle(document.querySelector(".btn")!).cursor,
          document.body.style.isolation,
          !!document.querySelector("[data-clipmunk-recorder=backdrop]"),
        ]),
      ).toEqual(["none", "none", "isolate", true]);
      await page.mouse.move(300, 300, { steps: 5 });
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 12 });
      await button.click();
      await page.getByRole("searchbox").click();
      await page.keyboard.type("secret", { delay: 40 });
      await page.waitForTimeout(600);
      recordedFor = Date.now() - started;
    });

    expect(
      await page.evaluate(() => [
        document.body.style.isolation,
        !!document.querySelector("[data-clipmunk-recorder]"),
        getComputedStyle(document.body).cursor,
      ]),
    ).toEqual(["", false, "auto"]);
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    expect(take.source).toMatchObject({
      width: viewport.width,
      height: viewport.height,
      screen: { file: "screen.webm" },
      events: { count: events.length },
    });
    // Chrome may round the captured element down by a pixel.
    expect(Math.abs(take.source.screen.width - viewport.width)).toBeLessThanOrEqual(2);
    expect(Math.abs(take.source.screen.height - viewport.height)).toBeLessThanOrEqual(2);
    expect(take.source.cam).toBeUndefined();
    expect(take.source.audio).toBeUndefined();
    // At least as long as the steps above took: the take runs from Record to Stop.
    expect(take.source.durationMs).toBeGreaterThan(recordedFor);
    expect(take.source.screen.latencyMs).toBeLessThan(1000);
    expect(take.edit.trim).toEqual({ startMs: 0, endMs: take.source.durationMs });
    // Clicking the button, then the search box and typing, is one burst with one caption; typing makes no pill.
    expect(resolveCaptions(take.edit, events).map((caption) => caption.text)).toEqual(["Click New report"]);
    expect(keyPills(events)).toEqual([]);
    // Reframed to 9:16, the clicked controls are inside the crop while they are pressed.
    const crop = reframePath(events, take.source, 9 / 16);
    for (const down of events)
      if (down.k === "down" && down.rect[2] <= crop.width) {
        const left = crop.at(down.t);
        expect(down.rect[0]).toBeGreaterThanOrEqual(left - 1e-6);
        expect(down.rect[0] + down.rect[2]).toBeLessThanOrEqual(left + crop.width + 1e-6);
      }

    const kinds = new Set(events.map((event) => event.k));
    for (const kind of ["resize", "move", "down", "up", "cursor", "focus", "type"]) expect(kinds, kind).toContain(kind);
    expect(events.map((event) => event.t)).toEqual([...events.map((event) => event.t)].sort((a, b) => a - b));
    const click = events.find((event) => event.k === "down")!;
    expect(click).toMatchObject({ k: "down", button: 0 });
    // The click carries the box of the button that was pressed, which is what auto-zoom targets.
    if (click.k === "down")
      for (const [index, expected] of [box.x, box.y, box.width, box.height].entries())
        expect(click.rect[index]).toBeCloseTo(expected, 0);
    expect(events.some((event) => event.k === "cursor" && event.style === "pointer")).toBe(true);
    expect(events.filter((event) => event.k === "type")).toHaveLength(6);
    expect(await readFile(path.join(dir, "events.jsonl"), "utf8")).not.toMatch(/secret|"key"/);

    // Where the HUD bar sat, the video shows the light page, not the dark bar.
    const bar = colourAt(
      path.join(dir, "screen.webm"),
      1,
      `120:20:${Math.round(viewport.width / 2 - 60)}:${viewport.height - 50}`,
    );
    expect(Math.min(...bar)).toBeGreaterThan(200);
    expect(existsSync(path.join(dir, "screen.raw.webm"))).toBe(false);
  }, 120_000);

  it("blurs redacted elements in the page while recording when the config asks, and gives the take their entries", async () => {
    const configFile = path.join(root, "clipmunk.config.json");
    const config = await readFile(configFile, "utf8");
    await writeFile(
      configFile,
      JSON.stringify({ ...JSON.parse(config), redact: { selectors: [".zz-live"], mode: "block", live: true } }),
    );
    try {
      await page.evaluate(() => {
        const box = document.createElement("div");
        box.id = "zz-live-fixture";
        box.className = "zz-live";
        box.textContent = "Card 4242 4242";
        box.style.cssText = "position:fixed;left:40px;top:200px;z-index:5;background:#fff;padding:8px";
        document.body.append(box);
      });
      const filter = () => page.evaluate(() => getComputedStyle(document.getElementById("zz-live-fixture")!).filter);
      expect(await filter()).toBe("none");
      let during = "";
      const { take, events } = await record({ camera: false, microphone: false }, async () => {
        during = await filter();
        await page.waitForTimeout(300);
      });
      expect(during).toBe("blur(12px)");
      expect(await filter()).toBe("none"); // the page is itself again once the recording stops
      expect(events.some((event) => event.k === "redact" && event.sel === ".zz-live")).toBe(true);
      expect(take.edit.redact).toEqual([{ sel: ".zz-live", mode: "block" }]);
    } finally {
      await writeFile(configFile, config);
      await page.evaluate(() => document.getElementById("zz-live-fixture")?.remove());
    }
  }, 120_000);

  it("logs which control was used, the route, shortcuts and redacted boxes, and nothing typed", async () => {
    const configFile = path.join(root, "clipmunk.config.json");
    const config = await readFile(configFile, "utf8");
    await writeFile(configFile, JSON.stringify({ ...JSON.parse(config), redact: [".zz-hidden"] }));
    try {
      // A card number to hide, and a password field, added to the page for this test.
      await page.evaluate(() => {
        const box = document.createElement("div");
        box.id = "zz-fixture";
        box.style.cssText = "position:fixed;left:40px;top:200px;z-index:5;background:#fff;padding:8px";
        box.innerHTML = `<div class="zz-hidden"><button id="zz-reveal">Card 4242 4242</button></div>
          <label>Password <input id="zz-pass" type="password"></label>`;
        document.body.append(box);
      });
      const { take, events, dir } = await record({ camera: false, microphone: false }, async () => {
        await page.getByRole("button", { name: "New report" }).click();
        await page.getByRole("searchbox").click();
        await page.keyboard.press("Meta+K");
        await page.locator("#zz-pass").click();
        await page.keyboard.type("hunter2", { delay: 30 });
        await page.keyboard.press("Control+A");
        await page.locator("#zz-reveal").click();
        await page.evaluate(() => {
          document.getElementById("zz-fixture")!.style.top = "260px";
        });
        await page.waitForTimeout(400);
      });
      const text = await readFile(path.join(dir, "events.jsonl"), "utf8");
      expect(events[1]).toMatchObject({ k: "route", path: "/" });
      const downs = events.filter((event) => event.k === "down");
      expect(downs[0]).toMatchObject({ el: { role: "button", name: "New report" } });
      const focusOnSearch = events.find((event) => event.k === "focus" && event.el?.role === "searchbox");
      expect(focusOnSearch).toBeDefined();
      // The shortcut in the search box is logged; the one in the password field is not.
      expect(events.filter((event) => event.k === "combo").map((event) => event.k === "combo" && event.keys)).toEqual([
        ["Meta", "K"],
      ]);
      // So the video shows ⌘K as a pill, and nothing for the typing in the password field.
      expect(keyPills(events).map((pill) => pill.keys)).toEqual([["⌘", "K"]]);
      // The click inside the redacted element is not captioned.
      expect(resolveCaptions(take.edit, events).some((caption) => /Card|4242/.test(caption.text))).toBe(false);
      const reveal = downs.find((event) => event.el?.sel.includes("zz-reveal"))!;
      expect(reveal.el).toEqual({ sel: "#zz-reveal", role: "button" }); // inside the redaction: no name
      const boxes = events.filter((event) => event.k === "redact");
      expect(boxes.length).toBeGreaterThanOrEqual(2);
      const first = boxes[0]!,
        last = boxes.at(-1)!;
      if (first.k === "redact" && last.k === "redact") {
        expect(first.sel).toBe(".zz-hidden");
        expect(last.rects[0]![1] - first.rects[0]![1]).toBeCloseTo(60, 0);
      }
      expect(text).not.toMatch(/4242|hunter2|Card/);
    } finally {
      await writeFile(configFile, config);
      await page.evaluate(() => document.getElementById("zz-fixture")?.remove());
    }
  }, 120_000);

  it("records camera and microphone together and extracts the voice track", async () => {
    const { take, dir } = await record({ camera: true, microphone: true }, async () => {
      await hud().locator("video.cam").waitFor({ state: "visible" });
      await page.mouse.move(500, 400, { steps: 8 });
      await page.waitForTimeout(1800);
    });
    withCamera = take.id;
    expect(take.source.cam).toMatchObject({ file: "cam.webm", hasAudio: true });
    expect(take.source.audio).toMatchObject({ file: "audio.wav" });
    expect(take.source.mic).toBeUndefined();
    expect(Math.abs(take.source.cam!.offsetMs)).toBeLessThan(1500);
    for (const file of ["screen.webm", "cam.webm", "audio.wav", "events.jsonl", "take.json", "edit.json"])
      expect(existsSync(path.join(dir, file)), file).toBe(true);
  }, 120_000);

  it("keeps the video and the event log on one clock, even when the page is still at the start", async () => {
    // A box that turns red the instant the pointer goes down: the same moment the log records.
    await page.evaluate(() => {
      const box = Object.assign(document.createElement("div"), { id: "sync-box" });
      box.style.cssText =
        "position:fixed;left:40px;top:300px;width:120px;height:120px;background:rgb(0,160,0);z-index:5";
      document.body.append(box);
      // Only the click on the page counts, not the one on the recorder's own Record button.
      const turnRed = (event: PointerEvent) => {
        if (event.clientX === 700) box.style.background = "rgb(255,0,0)";
      };
      addEventListener("pointerdown", turnRed, { capture: true });
    });
    const { take, events, dir } = await record({ camera: false, microphone: false }, async () => {
      await page.waitForTimeout(1800); // nothing repaints: a tab capture emits no frames here
      await page.mouse.click(700, 500);
      await page.waitForTimeout(900);
    });
    await page.evaluate(() => document.getElementById("sync-box")!.remove());
    const down = events.find((event) => event.k === "down")!;
    // First video frame in which the box is red, from FFmpeg's per-frame report of the cropped region.
    const report = spawnSync(
      ffmpeg,
      ["-hide_banner", "-i", path.join(dir, "screen.webm"), "-vf", "crop=60:60:70:330,showinfo", "-f", "null", "-"],
      { encoding: "utf8" },
    ).stderr;
    const frames = [...report.matchAll(/pts_time:([\d.]+).*?mean:\[(\d+) (\d+) (\d+)\]/g)].map((match) => ({
      t: Number(match[1]) * 1000,
      cr: Number(match[4]),
    }));
    expect(frames.length).toBeGreaterThan(3);
    expect(frames[0]!.cr).toBeLessThan(120); // green at the start
    const turnedRed = frames.find((frame) => frame.cr > 180)!;
    expect(turnedRed, "the click is visible in the video").toBeDefined();
    const facts = `click logged at ${down.t} ms, visible in video at ${Math.round(turnedRed.t)} ms, measured capture delay ${take.source.screen.latencyMs} ms, first frames at ${frames
      .slice(0, 4)
      .map((frame) => Math.round(frame.t))
      .join(", ")} ms`;
    // The picture changes no earlier than the logged click and within a few frames of it.
    writeFileSync(
      "/tmp/clipmunk-sync-facts.txt",
      `${facts}; all frame times: ${frames.map((frame) => `${Math.round(frame.t)}${frame.cr > 180 ? "R" : ""}`).join(" ")}\n`,
      { flag: "a" },
    );
    expect(turnedRed.t - down.t, facts).toBeGreaterThan(-40);
    expect(turnedRed.t - down.t, facts).toBeLessThan(120);
    expect(take.source.screen.latencyMs).toBeLessThan(400);
  }, 120_000);

  it("stops from the keyboard, so a recording can always be ended", async () => {
    await hud().locator("button.action").click();
    await recording();
    await page.mouse.move(420, 380, { steps: 5 });
    await page.waitForTimeout(1200);
    await page.keyboard.press("Alt+Shift+KeyR");
    await hud().locator(".status a").waitFor({ timeout: 30_000 });
    const id = new URL((await hud().locator(".status a").getAttribute("href"))!, origin).searchParams.get(
      "clipmunk-take",
    )!;
    takes.push(id);
    const log = await readFile(path.join(root, ".clipmunk/takes", id, "recorder.log"), "utf8");
    expect(log).toMatch(/ start \d+x\d+@/);
    expect(log).toMatch(/ stop after \d+ms/);
  }, 120_000);

  it("offers to save what was captured when the page reloads mid-recording", async () => {
    await hud().locator("button.action").click(); // "Record again"
    await recording();
    await page.mouse.move(300, 300, { steps: 5 });
    await page.mouse.move(700, 450, { steps: 10 });
    await page.waitForTimeout(2600);
    await page.reload(); // what a full-page navigation does to a tab capture
    // The recorder comes back by itself and explains what happened.
    await hud().locator(".status", { hasText: "reloaded or navigated" }).waitFor({ timeout: 20_000 });
    expect(await hud().locator("button.action").textContent()).toBe("Save recording");
    expect(await hud().locator("button.discard").isVisible()).toBe(true);
    await hud().locator("button.action").click();
    await hud().locator(".status a").waitFor({ timeout: 30_000 });
    const id = new URL((await hud().locator(".status a").getAttribute("href"))!, origin).searchParams.get(
      "clipmunk-take",
    )!;
    takes.push(id);
    const dir = path.join(root, ".clipmunk/takes", id);
    const take = await readTakeFiles(dir);
    if (!take.ok) throw new Error(JSON.stringify(take.issues));
    expect(take.data.source.durationMs).toBeGreaterThan(1500);
    expect(take.data.source.events.count).toBeGreaterThan(5);
    const log = await readFile(path.join(dir, "recorder.log"), "utf8");
    expect(log).toContain("pagehide");
    expect(log).toContain("page loaded again after an interrupted recording");
    // Nothing is left behind once it is saved: a further reload shows the ordinary recorder.
    await page.reload();
    await hud().locator(".status", { hasText: "Ready" }).waitFor({ timeout: 20_000 });
    expect(await hud().locator("button.discard").isVisible()).toBe(false);
  }, 120_000);

  it("does not record the studio itself", async () => {
    await page.goto(`${origin}/?clipmunk-frame=1&clipmunk-scene=rack-focus&clipmunk-record=1`);
    await hud()
      .locator(".status", { hasText: "records your app, not the Clipmunk studio" })
      .waitFor({ timeout: 20_000 });
    expect(await hud().locator("button.action").isDisabled()).toBe(true);
    await hud().locator("button.close").click();
  }, 60_000);

  it("opens a real recording in the editor and exports it with cursor, camera and voice", async () => {
    // The standalone Studio, served by the daemon that saved the takes.
    await page.goto(`${daemon.origin}/?clipmunk=1#clipmunk-daemon=${daemon.port}.${daemon.token}`);
    await page.locator(".row").first().waitFor({ timeout: 20_000 });
    expect(await page.locator(".row").count()).toBeGreaterThanOrEqual(takes.length); // the folder may hold takes recorded by hand
    expect((await page.locator(".row").allTextContents()).some((text) => text.includes("camera + voice"))).toBe(true);
    // A real MediaRecorder file (variable frame rate, remuxed) decodes and composites in the editor.
    await page.goto(`${daemon.origin}/?clipmunk=1&clipmunk-take=${withCamera}`);
    await page.waitForFunction(() => (window as any).__CLIPMUNK__?.kind === "take", undefined, { timeout: 45_000 });
    await page.evaluate(() => (window as any).__CLIPMUNK__.seek(1000));
    const drawn = await page.evaluate(() => {
      const canvas = document.querySelector("[data-clipmunk-chrome]")!.shadowRoot!.querySelector("canvas")!;
      const centre = canvas.getContext("2d")!.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data;
      return { width: canvas.width, height: canvas.height, centre: [centre[0], centre[1], centre[2]] };
    });
    expect(drawn).toMatchObject({ width: 1920, height: 1080 });
    expect(Math.max(...(drawn.centre as number[])), "the recording is drawn, not just the dark canvas").toBeGreaterThan(
      120,
    );

    const output = ".clipmunk/exports/zz-test-recorded.mp4";
    const result = await exportTake({ takeId: withCamera, url: origin, output, fps: 30, height: 540 }, { root });
    try {
      if (!result.ok) throw new Error(JSON.stringify(result.issues));
      expect(result.data).toMatchObject({ width: 960, height: 540, audio: true });
      expect(await probeMedia(output, root)).toMatchObject({ hasVideo: true, hasAudio: true });
      expect((await probeVideo(output, root)).frames).toBe(result.data.frames);
      expect(result.data.frames).toBeGreaterThan(40);
    } finally {
      await rm(path.join(root, output), { force: true });
    }
  }, 240_000);
});
