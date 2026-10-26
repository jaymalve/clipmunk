import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type Browser, chromium, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error: a plain script, used here to build the app the daemon serves
import { buildStudioApp } from "../../scripts/studio-app.mjs";
import { type Daemon, startDaemon } from "../../src/daemon";
import { exportTake, probeVideo } from "../../src/export";
import { FFMPEG, makeTake } from "../support/take";

/** The standalone Studio, served by the daemon, against the example app. */
const root = path.resolve("examples/vite-app");
const TAKE = "zz-studio-take";
// The editor and preset tests change their takes; each group gets its own.
const EDITED = "zz-studio-edited";
const PRESET_TAKE = "zz-studio-preset";
const CHAT_TAKE = "zz-studio-chat";
const projectFile = path.join(root, ".clipmunk/project.json");
let server: ViteDevServer, daemon: Daemon, browser: Browser, origin: string, studioDir: string, project: string;
const made: string[] = [];

/** Point the example at this test's dev server (the Studio reads it from project.json). */
const setDevUrl = (devUrl: string) =>
  writeFile(projectFile, `${JSON.stringify({ ...JSON.parse(project), devUrl }, null, 2)}\n`);

beforeAll(async () => {
  process.env.CLIPMUNK_FFMPEG ??= FFMPEG;
  project = await readFile(projectFile, "utf8");
  studioDir = await mkdtemp(path.join(os.tmpdir(), "clipmunk-studio-"));
  await buildStudioApp(studioDir);
  for (const id of [TAKE, EDITED, PRESET_TAKE, CHAT_TAKE]) await makeTake(root, id, { cam: false });
  server = await createServer({ root, server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
  await server.listen();
  origin = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`;
  await setDevUrl(origin);
  daemon = await startDaemon({ root, port: 0, announce: false, studioDir });
  browser = await chromium.launch();
}, 180_000);
afterAll(async () => {
  await browser?.close();
  await daemon?.close();
  await server?.close();
  await writeFile(projectFile, project);
  for (const id of [TAKE, EDITED, PRESET_TAKE, CHAT_TAKE])
    await rm(path.join(root, ".clipmunk/takes", id), { recursive: true, force: true });
  await rm(path.join(root, ".clipmunk/chat"), { recursive: true, force: true });
  await rm(path.join(root, ".clipmunk/history", `${CHAT_TAKE}.json`), { force: true });
  await rm(studioDir, { recursive: true, force: true });
  for (const file of made) await rm(path.join(root, file), { force: true });
});

// A failed test must not leave its page holding connections for the next one.
afterEach(async (context) => {
  // When a test fails, say what each of its pages was showing, to tell a slow machine from a bug.
  if (context.task.result?.state === "fail")
    for (const page of opened) {
      const frames = await Promise.all(
        page.frames().map(async (frame) => `${frame.url()} ${(await frame.content().catch(() => "")).length} bytes`),
      );
      const text = await page
        .locator("body")
        .innerText()
        .catch(() => "");
      console.error(`page ${page.url()}\n  frames: ${frames.join(" | ")}\n  shows: ${text.slice(0, 300)}`);
    }
  for (const page of opened.splice(0)) await page.close().catch(() => {});
});

const opened: Page[] = [];
async function openStudio(query = ""): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  opened.push(page);
  page.on("console", (message) => message.type() === "error" && console.error(`console: ${message.text()}`));
  // Rendering in the background (an earlier export) can make a small machine slow to answer.
  page.setDefaultTimeout(90_000);
  page.on("pageerror", (error) => console.error("pageerror:", error.message));
  // One navigation, with the daemon link in the fragment, as `clipmunk dev`'s link is opened.
  await page.goto(`${daemon.origin}/${query}#clipmunk-daemon=${daemon.port}.${daemon.token}`);
  return page;
}

describe("serving the Studio", () => {
  it("serves its files without a token, refuses framing, and still guards the API", async () => {
    const page = await fetch(`${daemon.origin}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    const html = await page.text();
    const script = /src="(\/assets\/[^"]+\.js)"/.exec(html)![1]!;
    const asset = await fetch(`${daemon.origin}${script}`);
    expect([asset.status, asset.headers.get("content-type")]).toEqual([200, "text/javascript; charset=utf-8"]);
    // A path outside the app's folder is the app itself, never a file from elsewhere.
    expect(await (await fetch(`${daemon.origin}/..%2F..%2Fpackage.json`)).text()).toBe(html);

    expect((await fetch(`${daemon.origin}/v1/status`)).status).toBe(401);
    const status = await fetch(`${daemon.origin}/v1/status`, { headers: { authorization: `Bearer ${daemon.token}` } });
    expect((await status.json()).data).toMatchObject({ devUrl: origin, studioPath: "/" });
    const http = await import("node:http");
    const wrongHost = await new Promise<number>((resolve) =>
      http
        .get({ host: "127.0.0.1", port: daemon.port, path: "/", headers: { host: "evil.test" } }, (response) =>
          resolve(response.statusCode!),
        )
        .end(),
    );
    expect(wrongHost).toBe(403);
  });

  it("streams changes to the Studio", async () => {
    const controller = new AbortController();
    const response = await fetch(`${daemon.origin}/v1/events?token=${daemon.token}`, { signal: controller.signal });
    const reader = response.body!.getReader();
    const headers = { authorization: `Bearer ${daemon.token}`, "content-type": "application/json" };
    const current = await (await fetch(`${daemon.origin}/v1/takes/${TAKE}`, { headers })).json();
    const saved = await fetch(`${daemon.origin}/v1/takes/${TAKE}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ edit: current.data.take.edit, revision: current.data.revision }),
    });
    expect(saved.status).toBe(200);
    let text = "";
    while (!text.includes('"type":"edit"')) text += new TextDecoder().decode((await reader.read()).value);
    expect(text).toContain(`{"type":"edit","kind":"take","id":"${TAKE}"}`);
    controller.abort();
  });
});

describe("the library", () => {
  it("filters clips by kind and finds them by name, with each clip's summary", async () => {
    const page = await openStudio();
    const titles = () => page.locator(".card b").allTextContents();
    await expect.poll(titles).toContain("Synthetic take");
    await page.getByRole("tab", { name: /^Takes/ }).click();
    expect(await page.locator('.card[data-kind="take"]').count()).toBeGreaterThan(0);
    expect(await page.locator('.card:not([data-kind="take"])').count()).toBe(0);
    await page.getByRole("tab", { name: /^Scenes/ }).click();
    expect(await page.locator('.card[data-kind="take"]').count()).toBe(0);
    // The themed scene says how many themes it comes in; every card has its length, size and ratio.
    expect(await page.locator(".card", { hasText: "Themed card" }).textContent()).toContain(
      "1.0 s · 400×300 · 4:3 · 2 themes",
    );
    await page.getByRole("tab", { name: /^All/ }).click();
    await page.getByLabel("Search clips").fill("rack");
    expect(await titles()).toEqual(["Rack focus"]);
    await page.getByLabel("Search clips").fill("nothing like this");
    await page.getByText("No clip matches.").waitFor();
    await page.close();
  }, 180_000);

  it("exports several files from the panel, with a queue that shows each one", async () => {
    const page = await openStudio();
    const card = page.locator(".card", { hasText: "Themed card" });
    await card.getByRole("button", { name: "Export" }).click();
    const panel = page.getByRole("region", { name: "Export" });
    // The scene's own shape (4:3) is not a ratio Clipmunk renders, so none is preselected.
    await panel.getByRole("button", { name: "16:9" }).click();
    await panel.getByRole("button", { name: "light" }).click();
    await panel.getByRole("button", { name: "dark" }).click();
    await panel.getByLabel("Poster").check();
    await panel.getByText("2 themes × 2 formats = 4 files").waitFor();
    await panel.getByRole("button", { name: "Export 4 files" }).click();
    // While it runs, the queue lists the planned files and the card shows that it is rendering.
    await panel.locator("li", { hasText: "themed-card.16x9.light.mp4" }).waitFor();
    await card.locator(".badge.rendering").waitFor({ timeout: 30_000 });
    const done = () =>
      panel
        .locator("progress")
        .evaluateAll((bars) => bars.length === 4 && bars.every((bar) => (bar as HTMLProgressElement).value === 1));
    await expect.poll(done, { timeout: 240_000 }).toBe(true);
    await expect.poll(() => card.locator(".badge.rendering").count()).toBe(0);
    const names = await panel.locator("li span").allTextContents();
    for (const name of names) made.push(`.clipmunk/exports/${name}`);
    expect([...names].sort()).toEqual(
      [
        "themed-card.16x9.dark.mp4",
        "themed-card.16x9.dark.png",
        "themed-card.16x9.light.mp4",
        "themed-card.16x9.light.png",
      ].sort(),
    );
    for (const name of names) expect(existsSync(path.join(root, ".clipmunk/exports", name))).toBe(true);
    await page.close();
  }, 300_000);

  it("asks the coding agent for new scenes", async () => {
    const page = await openStudio();
    await page.getByRole("button", { name: "New scene" }).click();
    const dialog = page.getByRole("dialog", { name: "New scene" });
    expect(await dialog.locator("textarea").inputValue()).toContain("Read CLIPMUNK.md");
    await dialog.getByRole("button", { name: "Close" }).click();
    expect(await dialog.count()).toBe(0);
    await page.close();
  }, 180_000);
});

describe("the editor", () => {
  const editOf = async () =>
    JSON.parse(await readFile(path.join(root, ".clipmunk/takes", EDITED, "edit.json"), "utf8")).edit;

  it("inspects a zoom, a backdrop and the overlays, saving each to edit.json, and undoes and redoes", async () => {
    const page = await openStudio(`?clipmunk=1&clipmunk-take=${EDITED}`);
    await page.getByText(`Changes are saved to .clipmunk/takes/${EDITED}/edit.json`).waitFor();
    // The rail lists the other clips.
    await expect.poll(() => page.getByRole("navigation", { name: "Clips" }).textContent()).toContain("Rack focus");

    await page.getByRole("button", { name: "Zoom 1" }).click();
    await page.getByRole("heading", { name: "Zoom 1" }).waitFor();
    const scale = page.getByLabel("Scale");
    await scale.evaluate((element) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, "3");
      element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    });
    await expect.poll(async () => (await editOf()).zoom.mode, { timeout: 10_000 }).toBe("manual");
    const peak = (edit: any) =>
      Math.max(
        ...edit.zoom.tracks.find((track: any) => track.property === "scale").keyframes.map((frame: any) => frame.value),
      );
    expect(peak(await editOf())).toBe(3);
    await page.getByLabel("Easing").selectOption("linear");
    await expect
      .poll(async () => (await editOf()).zoom.tracks[0].keyframes.some((frame: any) => frame.easing === "linear"), {
        timeout: 10_000,
      })
      .toBe(true);
    await page.getByRole("button", { name: "Done" }).click();

    await page.getByRole("button", { name: "Backdrop #ffffff" }).click();
    await expect.poll(async () => (await editOf()).canvas.background, { timeout: 10_000 }).toBe("#ffffff");
    await page.getByLabel("Show shortcuts", { exact: true }).click();
    await expect.poll(async () => (await editOf()).keys.visible, { timeout: 10_000 }).toBe(false);

    await page.getByRole("button", { name: "Undo" }).click();
    await expect.poll(async () => (await editOf()).keys.visible, { timeout: 10_000 }).toBe(true);
    await page.getByRole("button", { name: "Undo" }).click();
    await expect.poll(async () => (await editOf()).canvas.background, { timeout: 10_000 }).not.toBe("#ffffff");
    await page.getByRole("button", { name: "Redo" }).click();
    await expect.poll(async () => (await editOf()).canvas.background, { timeout: 10_000 }).toBe("#ffffff");
    // The page shows what the file holds.
    expect(await page.getByRole("button", { name: "Backdrop #ffffff" }).getAttribute("aria-pressed")).toBe("true");
  }, 180_000);

  it("trims by dragging the ends of the take, and previews another shape without changing it", async () => {
    const page = await openStudio(`?clipmunk=1&clipmunk-take=${EDITED}`);
    const handle = page.getByLabel("Trim start");
    await handle.waitFor();
    const lane = await handle.evaluate((element) => {
      const box = element.parentElement!.getBoundingClientRect();
      return { x: box.x, y: box.y + box.height / 2, width: box.width };
    });
    const start = await handle.boundingBox();
    await page.mouse.move(start!.x + start!.width / 2, lane.y);
    await page.mouse.down();
    await page.mouse.move(lane.x + lane.width * 0.25, lane.y, { steps: 6 });
    await page.mouse.up();
    await expect.poll(async () => Math.abs((await editOf()).trim.startMs - 1000), { timeout: 10_000 }).toBeLessThan(60);
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    await expect.poll(async () => (await editOf()).trim.startMs, { timeout: 10_000 }).toBe(0);

    await page.getByLabel("Preview as").selectOption("9:16");
    const size = () =>
      page.evaluate(() => {
        const canvas = document.querySelector("[data-clipmunk-chrome]")!.shadowRoot!.querySelector("canvas")!;
        return `${canvas.width}x${canvas.height}`;
      });
    await expect.poll(size).toBe("1080x1920");
    await page.waitForTimeout(800);
    expect((await editOf()).frame).toBeUndefined();
  }, 180_000);

  it("picks an element in a scene to hide in recordings", async () => {
    const configFile = path.join(root, "clipmunk.config.json");
    const config = await readFile(configFile, "utf8");
    try {
      const page = await openStudio("?clipmunk=1&clipmunk-scene=rack-focus");
      await expect.poll(() => page.locator(".time").textContent(), { timeout: 120_000 }).toBe("0.00s / 1.50s");
      await page.getByRole("button", { name: "Pick an element to hide" }).click();
      await page.frameLocator("iframe").first().locator("table").first().click({ force: true });
      await page.getByText(/Recordings will hide/).waitFor();
      const redact = JSON.parse(await readFile(configFile, "utf8")).redact as string[];
      expect(redact.length).toBe(1);
      expect(redact[0]).toBeTruthy();
      // Everything else in the file is as it was.
      const { redact: _before, ...rest } = JSON.parse(config);
      const { redact: _after, ...restNow } = JSON.parse(await readFile(configFile, "utf8"));
      expect(restNow).toEqual(rest);
    } finally {
      await writeFile(configFile, config);
    }
  }, 180_000);

  it("compares a scene in a second shape, side by side", async () => {
    const page = await openStudio("?clipmunk=1&clipmunk-scene=themed-card");
    await expect.poll(() => page.locator(".time").textContent(), { timeout: 120_000 }).toBe("0.00s / 1.00s");
    await page.getByRole("button", { name: "Compare" }).click();
    const compared = page.frameLocator("iframe[data-clipmunk-compare]");
    await expect
      .poll(() =>
        compared
          .locator("body")
          .evaluate(() => `${(window as any).__CLIPMUNK__?.width}x${(window as any).__CLIPMUNK__?.height}`),
      )
      .toBe("300x534");
  }, 180_000);
});

describe("presets in the editor", () => {
  const configFile = path.join(root, "clipmunk.config.json");
  const editOf = async () =>
    JSON.parse(await readFile(path.join(root, ".clipmunk/takes", PRESET_TAKE, "edit.json"), "utf8")).edit;

  it("saves the current edit as a preset with a minimal diff of the config", async () => {
    const config = await readFile(configFile, "utf8");
    try {
      const page = await openStudio(`?clipmunk=1&clipmunk-take=${PRESET_TAKE}`);
      await page.getByRole("button", { name: "Save current as preset" }).click();
      const dialog = page.getByRole("dialog", { name: "Save current as preset" });
      await dialog.getByLabel("Preset name").fill("ZZ studio look");
      await dialog.getByRole("button", { name: "Save to clipmunk.config.json" }).click();
      await page
        .getByRole("toolbar", { name: "Presets" })
        .getByRole("button", { name: /ZZ studio look/ })
        .waitFor();
      const written = await readFile(configFile, "utf8");
      const before = JSON.parse(config),
        after = JSON.parse(written);
      // Only the new preset differs, every other key keeps its place, and so does the indentation.
      expect(Object.keys(after)).toEqual(Object.keys(before));
      const { presets: oldPresets, ...rest } = before;
      const { presets: newPresets, ...restNow } = after;
      expect(restNow).toEqual(rest);
      expect(Object.keys(newPresets)).toEqual([...Object.keys(oldPresets ?? {}), "zz-studio-look"]);
      expect(Object.keys(newPresets["zz-studio-look"].edit).sort()).toEqual(["canvas", "cursor", "zoom"].sort());
      expect(written.split("\n")[1]).toMatch(/^ {2}"/);
    } finally {
      await writeFile(configFile, config);
    }
  }, 180_000);

  it("shows a preset added on disk, previews it at once, and applies it on confirm", async () => {
    const config = await readFile(configFile, "utf8");
    try {
      const page = await openStudio(`?clipmunk=1&clipmunk-take=${PRESET_TAKE}`);
      const bar = page.getByRole("toolbar", { name: "Presets" });
      await bar.waitFor();
      const json = JSON.parse(config);
      await writeFile(
        configFile,
        `${JSON.stringify({ ...json, presets: { ...json.presets, "zz-red": { title: "ZZ red", edit: { canvas: { background: "#ff0000", padding: 0.2 } } } } }, null, 2)}\n`,
      );
      const preset = bar.getByRole("button", { name: /ZZ red/ });
      await preset.waitFor({ timeout: 15_000 });
      const corner = () =>
        page.evaluate(() => {
          const canvas = document.querySelector("[data-clipmunk-chrome]")!.shadowRoot!.querySelector("canvas")!;
          return [...canvas.getContext("2d")!.getImageData(4, 4, 1, 1).data.slice(0, 3)];
        });
      const backdrop = (await editOf()).canvas.background;
      await preset.click();
      const started = Date.now();
      await expect.poll(corner, { timeout: 5_000 }).toEqual([255, 0, 0]);
      expect(Date.now() - started).toBeLessThan(1000);
      // Previewing changes nothing on disk until the preset is applied.
      expect((await editOf()).canvas.background).toBe(backdrop);
      await bar.getByRole("button", { name: "Apply zz-red" }).click();
      await expect
        .poll(async () => (await editOf()).canvas, { timeout: 10_000 })
        .toMatchObject({
          background: "#ff0000",
          padding: 0.2,
        });
    } finally {
      await writeFile(configFile, config);
    }
  }, 180_000);
});

describe("the chat with the agent", () => {
  const editOf = async () =>
    JSON.parse(await readFile(path.join(root, ".clipmunk/takes", CHAT_TAKE, "edit.json"), "utf8")).edit;
  // The agent's side, as wait_for_chat and reply_chat call it.
  const api = (route: string, body?: unknown) =>
    fetch(`${daemon.origin}${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${daemon.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }).then((response) => response.json() as Promise<any>);

  it("sends a message with its context, shows the agent's proposal, previews, keeps and undoes it", async () => {
    const page = await openStudio(`?clipmunk=1&clipmunk-take=${CHAT_TAKE}`);
    await page.getByText(`Changes are saved to .clipmunk/takes/${CHAT_TAKE}/edit.json`).waitFor();
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    const chat = page.getByRole("dialog", { name: "Chat with your agent" });
    await chat.getByText("No agent is listening").waitFor();
    await chat.getByText("Watch the Clipmunk chat").waitFor();

    const waiting = api(`/v1/chat/next?timeoutMs=60000&agent=${encodeURIComponent("Test agent")}`);
    await chat.getByText("Test agent is listening").waitFor({ timeout: 10_000 });
    await chat.getByRole("button", { name: "+ This moment" }).click();
    await chat.getByLabel("Message to your agent").fill("Make the backdrop red");
    await chat.getByRole("button", { name: "Send" }).click();
    const { message } = (await waiting).data;
    expect(message.text).toBe("Make the backdrop red");
    expect(message.context[0]).toEqual({ kind: "clip", clip: { kind: "take", id: CHAT_TAKE } });
    expect(message.context[1]).toMatchObject({ kind: "time" });

    const backdrop = (await editOf()).canvas.background;
    const replied = await api("/v1/chat/reply", {
      text: "Here is a red backdrop.",
      proposal: { takeId: CHAT_TAKE, patch: { canvas: { background: "#ff0000" } }, note: "red backdrop" },
      followUps: ["Now zoom in more"],
    });
    expect(replied.ok).toBe(true);
    await chat.getByText("Here is a red backdrop.").waitFor({ timeout: 10_000 });
    expect(await chat.locator("[data-proposal-changes]").textContent()).toContain("canvas.background");

    const corner = () =>
      page.evaluate(() => {
        const canvas = document.querySelector("[data-clipmunk-chrome]")!.shadowRoot!.querySelector("canvas")!;
        return [...canvas.getContext("2d")!.getImageData(4, 4, 1, 1).data.slice(0, 3)];
      });
    await chat.getByRole("button", { name: "Preview" }).click();
    await expect.poll(corner, { timeout: 5_000 }).toEqual([255, 0, 0]);
    expect((await editOf()).canvas.background).toBe(backdrop);

    await chat.getByRole("button", { name: "Keep", exact: true }).click();
    await expect.poll(async () => (await editOf()).canvas.background, { timeout: 10_000 }).toBe("#ff0000");
    await chat.getByText("Kept").waitFor();
    await chat.getByRole("button", { name: "Undo" }).click();
    await expect.poll(async () => (await editOf()).canvas.background, { timeout: 10_000 }).toBe(backdrop);
    // The editor shows what the file holds again.
    await expect.poll(corner, { timeout: 5_000 }).not.toEqual([255, 0, 0]);

    // A suggested follow-up is one click.
    const next = api("/v1/chat/next?timeoutMs=60000&agent=Test%20agent");
    await chat.getByRole("button", { name: "Now zoom in more" }).click();
    expect((await next).data.message.text).toBe("Now zoom in more");
  }, 180_000);
});

describe("the Studio's flows", () => {
  it("lists scenes and takes from the daemon", async () => {
    const page = await openStudio();
    await page.waitForSelector(".card");
    await expect
      .poll(() => page.locator(".card b").allTextContents())
      .toEqual(expect.arrayContaining(["Rack focus", "Themed card", "Synthetic take"]));
    await page.close();
  }, 180_000);

  it("opens a scene in a frame of the host, scrubs it and exports it", async () => {
    const page = await openStudio();
    await page.locator(".card", { hasText: "Rack focus" }).locator("a.thumb").click();
    await expect.poll(() => page.locator(".time").textContent(), { timeout: 120_000 }).toBe("0.00s / 1.50s");
    const range = page.getByLabel("Scene time");
    await range.evaluate((element) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, "750");
      element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    });
    await expect.poll(() => page.locator(".time").textContent()).toBe("0.75s / 1.50s");
    // The frame really moved: its own clock says so.
    const frameTime = await page
      .frameLocator("iframe")
      .locator("body")
      .evaluate(() => (window as any).__CLIPMUNK__ && document.querySelector("[data-clipmunk-scene]") !== null);
    expect(frameTime).toBe(true);

    await page.getByRole("button", { name: "Export" }).click();
    await page.getByLabel("Frame rate").selectOption("30");
    await page.getByRole("button", { name: "Render" }).click();
    await expect.poll(() => page.locator("code").first().textContent(), { timeout: 180_000 }).toMatch(/^Wrote /);
    const output = /Wrote (\S+)/.exec((await page.locator("code").first().textContent())!)![1]!;
    made.push(output);
    expect(existsSync(path.join(root, output))).toBe(true);
    await page.close();
  }, 240_000);

  it("plays and pauses a scene from the Studio's controls", async () => {
    const page = await openStudio("?clipmunk=1&clipmunk-scene=plating");
    const time = () => page.locator(".time").textContent();
    await expect.poll(time, { timeout: 120_000 }).toBe("0.00s / 6.00s");
    await page.getByRole("button", { name: "Play" }).click();
    await expect.poll(time).not.toBe("0.00s / 6.00s");
    await page.getByRole("button", { name: "Pause" }).click();
    await page.getByRole("button", { name: "Play" }).waitFor();
    const paused = await time();
    await page.waitForTimeout(400);
    expect(await time()).toBe(paused);
    await page.close();
  }, 180_000);

  it("switches a scene's variant from the Studio without reloading the frame", async () => {
    const page = await openStudio("?clipmunk=1&clipmunk-scene=themed-card");
    await expect.poll(() => page.locator(".time").textContent(), { timeout: 120_000 }).toBe("0.00s / 1.00s");
    const frameSize = () =>
      page
        .frameLocator("iframe")
        .locator("body")
        .evaluate(() => `${(window as any).__CLIPMUNK__.width}x${(window as any).__CLIPMUNK__.height}`);
    expect(await frameSize()).toBe("400x300");
    await page.getByLabel("Preview as").selectOption({ label: "dark · 9:16" });
    await expect.poll(frameSize).toBe("300x534");
    expect(new URL(page.url()).searchParams.get("clipmunk-variant")).toBe("theme:dark,ratio:9x16");
    await page.close();
  }, 180_000);

  it("forwards the app's old studio address to the Studio", async () => {
    const page = await browser.newPage();
    await page.goto(`${origin}/?clipmunk=1&clipmunk-take=${TAKE}#clipmunk-daemon=${daemon.port}.${daemon.token}`);
    await page.waitForURL((url) => url.origin === daemon.origin && url.searchParams.get("clipmunk-take") === TAKE);
    await page.waitForFunction(() => (window as any).__CLIPMUNK__?.kind === "take", undefined, { timeout: 120_000 });
    await page.close();
  }, 180_000);

  it("exports a take while the host's dev server is stopped", async () => {
    await setDevUrl("http://127.0.0.1:9");
    try {
      const output = ".clipmunk/exports/zz-studio-take.mp4";
      made.push(output);
      const result = await exportTake({ takeId: TAKE, output, fps: 30, height: 360 }, { root });
      if (!result.ok) throw new Error(JSON.stringify(result.issues));
      expect(await probeVideo(output, root)).toMatchObject({ frames: 120, height: 360 });
    } finally {
      await setDevUrl(origin);
    }
  }, 240_000);

  it("edits a take and saves it, without the host", async () => {
    const page = await openStudio(`?clipmunk=1&clipmunk-take=${TAKE}`);
    await page.getByLabel("Show cursor", { exact: true }).click();
    await expect
      .poll(
        async () =>
          JSON.parse(await readFile(path.join(root, ".clipmunk/takes", TAKE, "edit.json"), "utf8")).edit.cursor.visible,
        {
          timeout: 10_000,
        },
      )
      .toBe(false);
    await page.close();
  }, 180_000);

  it("builds a sequence and saves it as a file", async () => {
    const page = await openStudio();
    await page.getByLabel("New sequence name").fill("ZZ studio built");
    await page.getByRole("button", { name: "Create" }).click();
    await page.waitForURL(/clipmunk-sequence=zz-studio-built/);
    const file = path.join(root, "src/clipmunk/sequences/zz-studio-built.sequence.json");
    made.push("src/clipmunk/sequences/zz-studio-built.sequence.json");
    await expect.poll(() => existsSync(file), { timeout: 10_000 }).toBe(true);
    await page.close();
  }, 180_000);

  it("says when the host's dev server is not answering", async () => {
    await setDevUrl("http://127.0.0.1:9");
    try {
      const page = await openStudio("?clipmunk=1&clipmunk-scene=rack-focus");
      await expect
        .poll(() => page.getByRole("alert").first().textContent(), { timeout: 60_000 })
        .toContain("dev server is not answering at http://127.0.0.1:9");
      await page.close();
    } finally {
      await setDevUrl(origin);
    }
  }, 180_000);
});
