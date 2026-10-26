import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type Browser, chromium, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error: a plain script, used here to build the app the daemon serves
import { buildStudioApp } from "../../scripts/studio-app.mjs";
import { type Daemon, startDaemon } from "../../src/daemon";
import { FFMPEG, makeTake } from "../support/take";

/** The standalone Studio, served by the daemon, against the example app. */
const root = path.resolve("examples/vite-app");
const TAKE = "zz-studio-take";
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
  await makeTake(root, TAKE, { cam: false });
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
  await rm(path.join(root, ".clipmunk/takes", TAKE), { recursive: true, force: true });
  await rm(studioDir, { recursive: true, force: true });
  for (const file of made) await rm(path.join(root, file), { force: true });
});

const link = () => `${daemon.origin}/#clipmunk-daemon=${daemon.port}.${daemon.token}`;
async function openStudio(query = ""): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (error) => console.error("pageerror:", error.message));
  await page.goto(link());
  if (query) await page.goto(`${daemon.origin}/${query}`);
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

describe("the Studio's flows", () => {
  it("lists scenes and takes from the daemon", async () => {
    const page = await openStudio();
    await page.waitForSelector(".tile");
    expect(await page.locator(".tile b").allTextContents()).toEqual(
      expect.arrayContaining(["Rack focus", "Themed card"]),
    );
    await expect.poll(() => page.locator(".row b").allTextContents()).toContain("Synthetic take");
    await page.close();
  }, 60_000);

  it("opens a scene in a frame of the host, scrubs it and exports it", async () => {
    const page = await openStudio();
    await page.locator(".tile", { hasText: "Rack focus" }).click();
    await expect.poll(() => page.locator(".time").textContent(), { timeout: 45_000 }).toBe("0.00s / 1.50s");
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
  }, 60_000);

  it("builds a sequence and saves it as a file", async () => {
    const page = await openStudio();
    await page.getByLabel("New sequence name").fill("ZZ studio built");
    await page.getByRole("button", { name: "Create" }).click();
    await page.waitForURL(/clipmunk-sequence=zz-studio-built/);
    const file = path.join(root, "src/clipmunk/sequences/zz-studio-built.sequence.json");
    made.push("src/clipmunk/sequences/zz-studio-built.sequence.json");
    await expect.poll(() => existsSync(file), { timeout: 10_000 }).toBe(true);
    await page.close();
  }, 60_000);

  it("says when the host's dev server is not answering", async () => {
    await setDevUrl("http://127.0.0.1:9");
    try {
      const page = await openStudio("?clipmunk=1&clipmunk-scene=rack-focus");
      await expect
        .poll(() => page.locator(".issues").textContent(), { timeout: 20_000 })
        .toContain("dev server is not answering at http://127.0.0.1:9");
      await page.close();
    } finally {
      await setDevUrl(origin);
    }
  }, 60_000);
});
