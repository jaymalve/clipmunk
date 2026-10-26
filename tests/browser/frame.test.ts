import path from "node:path";
import { type Browser, chromium, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Daemon, startDaemon } from "../../src/daemon";

/** The frame page, driven the way the Studio drives it: from a parent page on the daemon's origin. */
const root = path.resolve("examples/vite-app");
let server: ViteDevServer, daemon: Daemon, browser: Browser, origin: string;
type Message = { origin: string; data: { cm: number; type: string; [key: string]: unknown } };

beforeAll(async () => {
  server = await createServer({ root, server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
  await server.listen();
  origin = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`;
  daemon = await startDaemon({ root, port: 0, announce: false });
  // The parent page is fulfilled by Playwright, which Chrome treats as a public page framing a
  // loopback one; the real Studio is served from loopback by the daemon, where no check applies.
  browser = await chromium.launch({ args: ["--disable-features=LocalNetworkAccessChecks"] });
}, 60_000);
afterAll(async () => {
  await browser?.close();
  await daemon?.close();
  await server?.close();
});

/** A parent page at `parent` holding the frame page for `scene` in an iframe, recording what it hears. */
async function host(scene: string, parent = `http://127.0.0.1:${daemon.port}/frame-host`): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const src = `${origin}/?clipmunk-frame=1&clipmunk-scene=${scene}#clipmunk-daemon=${daemon.port}.${daemon.token}`;
  await page.route(parent, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><script>window.heard=[];addEventListener("message",(e)=>heard.push({origin:e.origin,data:e.data}));
        window.send=(m)=>document.querySelector("iframe").contentWindow.postMessage({cm:1,...m},"${origin}");</script>
        <iframe src="${src}" style="width:1000px;height:700px;border:0" allow="autoplay; microphone"></iframe>`,
    }),
  );
  await page.goto(parent);
  return page;
}
const heard = (page: Page) => page.evaluate(() => (window as unknown as { heard: Message[] }).heard);
const waitFor = (page: Page, test: (messages: Message[]) => boolean, timeout = 30_000) =>
  expect.poll(async () => test(await heard(page)), { timeout }).toBe(true);
const send = (page: Page, message: Record<string, unknown>) =>
  page.evaluate((m) => (window as unknown as { send(m: unknown): void }).send(m), message);

describe("frame page", () => {
  it("announces the scene, answers seeks with the latest, plays with ticks and pauses", async () => {
    const page = await host("rack-focus");
    await waitFor(page, (messages) => messages.some((message) => message.data.type === "ready"));
    const ready = (await heard(page)).find((message) => message.data.type === "ready")!;
    expect(ready.origin).toBe(origin);
    expect(ready.data).toMatchObject({ cm: 1, durationMs: 1500, width: 1000, height: 600, variant: "" });

    await send(page, { type: "seek", t: 750, seq: 1 });
    await waitFor(page, (messages) =>
      messages.some((message) => message.data.type === "frame" && message.data.seq === 1),
    );
    expect((await heard(page)).find((message) => message.data.seq === 1)!.data.t).toBe(750);
    // A burst of seeks: the last one is always answered, and stale ones may be skipped.
    for (let seq = 2; seq <= 12; seq++) await send(page, { type: "seek", t: seq * 100, seq });
    await waitFor(page, (messages) =>
      messages.some((message) => message.data.type === "frame" && message.data.seq === 12),
    );
    const answered = (await heard(page)).filter((message) => message.data.type === "frame").map((m) => m.data.seq);
    expect(answered.at(-1)).toBe(12);
    expect((await heard(page)).find((message) => message.data.seq === 12)!.data.t).toBe(1200);

    await send(page, { type: "play", from: 0 });
    await waitFor(page, (messages) => messages.some((message) => message.data.type === "stopped"));
    const ticks = (await heard(page)).filter((message) => message.data.type === "tick").map((m) => m.data.t as number);
    expect(ticks.length).toBeGreaterThan(5);
    expect(ticks.every((t, index) => index === 0 || t >= ticks[index - 1]!)).toBe(true);
    expect(ticks.at(-1)).toBe(1500);

    await send(page, { type: "play", from: 0 });
    await waitFor(page, (messages) => messages.filter((message) => message.data.type === "tick").length > ticks.length);
    await send(page, { type: "pause" });
    await waitFor(page, (messages) => messages.filter((message) => message.data.type === "stopped").length === 2);
    const stoppedAt = (await heard(page)).filter((message) => message.data.type === "stopped").at(-1)!.data.t as number;
    expect(stoppedAt).toBeLessThan(1500);
    await page.close();
  }, 60_000);

  it("picks an element with its identity and its box in scene pixels", async () => {
    const page = await host("rack-focus");
    await waitFor(page, (messages) => messages.some((message) => message.data.type === "ready"));
    await send(page, { type: "pick", on: true });
    // Picking intercepts the click, so the scene's own handlers never see it.
    await page.frameLocator("iframe").locator("table").first().click({ force: true });
    await waitFor(page, (messages) => messages.some((message) => message.data.type === "picked"));
    const picked = (await heard(page)).find((message) => message.data.type === "picked")!.data;
    expect((picked.el as { sel: string }).sel).toBeTruthy();
    const [x, y, w, h] = picked.rect as number[];
    // Inside the 1000x600 scene, whatever the fit scale of the iframe.
    expect(x! >= 0 && y! >= 0 && x! + w! <= 1000.5 && y! + h! <= 600.5 && w! > 0 && h! > 0).toBe(true);
    await page.close();
  }, 60_000);

  it("switches variants on request and announces the new frame", async () => {
    const page = await host("themed-card");
    await waitFor(page, (messages) => messages.some((message) => message.data.type === "ready"));
    await send(page, { type: "variant", variant: "theme:dark,ratio:9x16" });
    await waitFor(page, (messages) =>
      messages.some((message) => message.data.type === "ready" && message.data.variant === "theme:dark,ratio:9x16"),
    );
    const latest = (await heard(page)).filter((message) => message.data.type === "ready").at(-1)!.data;
    expect(latest).toMatchObject({ width: 300, height: 534 });
    await page.close();
  }, 60_000);

  it("ignores pages that are not the Studio, and tells them nothing", async () => {
    const page = await host("rack-focus", "http://127.0.0.1:9/elsewhere");
    await page.frameLocator("iframe").locator('[data-clipmunk-scene][data-clipmunk-valid="true"]').waitFor();
    await send(page, { type: "seek", t: 500, seq: 1 });
    await page.waitForTimeout(800);
    expect(await heard(page)).toEqual([]);
    await page.close();
  }, 60_000);
});
