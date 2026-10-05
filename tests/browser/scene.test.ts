import { chromium, type Browser, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** Drives the example app in a real browser: the renderer must be valid, deterministic and playable. */
let server: ViteDevServer, browser: Browser, page: Page, origin: string;
const errors: string[] = [];

const seek = (ms: number) =>
  page.locator("input[type=range]").evaluate((element, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, String(value));
    element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  }, ms);
const frame = () => page.locator('[data-flick-capture="scene"]').screenshot();
const open = async (scene: string) => {
  await page.goto(`${origin}/?flick=1&flick-scene=${scene}`);
  await page.waitForSelector('[data-flick-scene][data-flick-valid="true"]');
};

beforeAll(async () => {
  server = await createServer({ root: "examples/vite-app", server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
  await server.listen();
  const address = server.httpServer!.address() as { port: number };
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (error) => errors.push(error.message));
}, 60_000);
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

describe.each(["page-survey", "plating"])("scene %s", (scene) => {
  it("renders the same pixels whenever it returns to the same time", async () => {
    await open(scene);
    await seek(1500);
    const first = await frame();
    await seek(4200);
    const later = await frame();
    await seek(1500);
    const again = await frame();
    expect(later.equals(first)).toBe(false);
    expect(again.equals(first)).toBe(true);
  }, 60_000);
});

describe("depth of field", () => {
  it("uses a depth-varying filter on a tilted surface and none when blur is off", async () => {
    await open("page-survey");
    const filter = () => page.locator("[data-flick-leaf]").first().evaluate((element) => (element as HTMLElement).style.filter);
    expect(await filter()).toMatch(/^url\(/);
    expect(await page.locator("filter feGaussianBlur").count()).toBeGreaterThan(1);
  }, 60_000);
});

describe("playback", () => {
  it("advances the shared clock from the Play button and stops at the end of a seek", async () => {
    await open("plating");
    const time = () => page.locator(".time").textContent();
    expect(await time()).toBe("0.00s / 6.00s");
    await page.getByRole("button", { name: "Play" }).click();
    await page.waitForTimeout(700);
    await page.getByRole("button", { name: "Pause" }).click();
    const paused = await time();
    expect(paused).not.toBe("0.00s / 6.00s");
    await page.waitForTimeout(300);
    expect(await time()).toBe(paused);
    await seek(6000);
    expect(await page.getByRole("button", { name: "Replay" }).count()).toBe(1);
  }, 60_000);

  it("drives host components that read scene time", async () => {
    await open("plating");
    const reveal = () => page.locator("#orbit-reveal rect").getAttribute("width");
    await seek(0);
    expect(Number(await reveal())).toBe(0);
    await seek(6000);
    expect(Number(await reveal())).toBe(640);
  }, 60_000);
});

describe("studio", () => {
  it("lists every scene and opens one from the library", async () => {
    await page.goto(`${origin}/?flick=1`);
    await page.waitForSelector(".tile");
    expect(await page.locator(".tile b").allTextContents()).toEqual(["Page survey", "Plating", "Rack focus"]);
    await page.locator(".tile", { hasText: "Rack focus" }).click();
    await page.waitForSelector('[data-flick-scene][data-flick-valid="true"]');
    expect(new URL(page.url()).searchParams.get("flick-scene")).toBe("rack-focus");
  }, 60_000);

  it("explains an unknown scene instead of showing a blank page", async () => {
    await page.goto(`${origin}/?flick=1&flick-scene=nope`);
    await page.waitForSelector(".issues");
    expect(await page.locator(".issues").textContent()).toContain('No valid scene named "nope"');
  }, 60_000);

  it("uses one uniform blur per flat layer and moves it with the focus track", async () => {
    await open("rack-focus");
    const blur = (id: string) => page.locator(`[data-flick-id="${id}"] [data-flick-leaf]`).evaluate((element) => parseFloat(/blur\(([\d.]+)px\)/.exec((element as HTMLElement).style.filter)?.[1] ?? "0"));
    await seek(0);
    const [cardStart, tableStart] = [await blur("card"), await blur("table")];
    await seek(1500);
    const [cardEnd, tableEnd] = [await blur("card"), await blur("table")];
    expect(cardStart).toBe(0);
    expect(tableStart).toBeGreaterThan(3);
    expect(cardEnd).toBeGreaterThan(3);
    expect(tableEnd).toBe(0);
    expect(await page.locator("filter").count()).toBe(0);
  }, 60_000);

  it("exposes a capture bridge that rejects times outside the scene", async () => {
    await open("rack-focus");
    const bridge = await page.evaluate(() => { const b = (window as any).__FLICK__; return { version: b.version, kind: b.kind, durationMs: b.durationMs, width: b.width, height: b.height, selector: b.selector }; });
    expect(bridge).toEqual({ version: 1, kind: "scene", durationMs: 1500, width: 1000, height: 600, selector: '[data-flick-capture="scene"]' });
    await page.evaluate(() => (window as any).__FLICK__.seek(750));
    expect(await page.locator(".time").textContent()).toBe("0.75s / 1.50s");
    expect(await page.evaluate(() => (window as any).__FLICK__.seek(9999).then(() => "ok", (e: Error) => e.message))).toContain("outside the scene");
  }, 60_000);
});

it("leaves the normal app untouched and reports no page errors", async () => {
  await page.goto(origin);
  expect(await page.locator("[data-flick-scene]").count()).toBe(0);
  expect(await page.getByRole("heading", { name: "Good morning, Maya" }).count()).toBe(1);
  expect(errors).toEqual([]);
}, 60_000);
