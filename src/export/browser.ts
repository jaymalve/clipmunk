import type { Browser, CDPSession, Page } from "playwright";
import { Fault } from "../project";

/** One headless page holding one clip, driven through its capture bridge.
 * The page is private to the exporter: studio chrome is hidden here and nowhere else.
 */
export type ClipInfo = { kind: string; durationMs: number; width: number; height: number; selector: string };
export type ClipPage = {
  info: ClipInfo;
  /** Apply the frame at `timeMs` and return it encoded as PNG or JPEG. */
  frame(timeMs: number, format: "png" | "jpeg"): Promise<Buffer>;
  close(): Promise<void>;
};

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const HIDE_CHROME = "[data-flick-chrome],nextjs-portal,vite-error-overlay{display:none!important}";

export async function launchBrowser(): Promise<Browser> {
  let playwright: typeof import("playwright");
  try {
    playwright = await import("playwright");
  } catch {
    throw new Fault("missing-playwright", "Rendering needs Playwright. Install it in this project: npm install -D playwright && npx playwright install chromium");
  }
  try {
    return await playwright.chromium.launch({ headless: true });
  } catch (error) {
    throw new Fault("missing-chromium", `Chromium could not start. Run: npx playwright install chromium\n${(error as Error).message.split("\n")[0]}`);
  }
}

export async function openClip(browser: Browser, url: string, viewport: { width: number; height: number }): Promise<ClipPage> {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page: Page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  // The exporter only ever talks to the developer's own machine.
  await page.route("**/*", (route) => {
    const request = route.request();
    if (!request.isNavigationRequest()) return route.continue();
    const target = new URL(request.url());
    return target.protocol === "http:" && LOOPBACK.has(target.hostname) ? route.continue() : route.abort();
  });
  try {
    try {
      await page.goto(url, { waitUntil: "load" });
    } catch {
      throw new Fault("server-unreachable", `Could not open ${url}. Start your dev server, or pass its address with --url.`);
    }
    await page.addStyleTag({ content: HIDE_CHROME });
    try {
      await page.waitForFunction(() => typeof (window as { __FLICK__?: { seek?: unknown } }).__FLICK__?.seek === "function", undefined, { timeout: 20_000 });
    } catch {
      const issues = await page.evaluate(() => document.querySelector("[data-flick-chrome]")?.shadowRoot?.querySelector(".issues")?.textContent ?? "");
      throw new Fault("clip-not-ready", `The scene did not open at ${url}. ${issues || pageErrors[0] || "Check that this URL shows the scene in your browser and that the app was connected with flick init."}`);
    }
    const info = await page.evaluate(async () => {
      const bridge = (window as unknown as { __FLICK__: ClipInfo & { ready(): Promise<void> } }).__FLICK__;
      await bridge.ready();
      return { kind: bridge.kind, durationMs: bridge.durationMs, width: bridge.width, height: bridge.height, selector: bridge.selector };
    });
    const locator = page.locator(info.selector);
    if ((await locator.count()) !== 1) throw new Fault("invalid-capture", "The page must contain exactly one capture element.");
    const box = await locator.boundingBox();
    if (!box || box.width < 1 || box.height < 1) throw new Fault("invalid-capture", "The capture element is not visible.");
    const clip = { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 };
    const cdp: CDPSession = await context.newCDPSession(page);
    return {
      info,
      async frame(timeMs, format) {
        try {
          await page.evaluate((time) => (window as unknown as { __FLICK__: { seek(t: number): Promise<void> } }).__FLICK__.seek(time), timeMs);
        } catch (error) {
          throw new Fault("capture-failed", (error as Error).message.split("\n")[0]!.replace(/^page\.evaluate: (Error: )?/, ""));
        }
        // The DevTools protocol call is about twice as fast as Playwright's own PNG screenshot.
        const shot = await cdp.send("Page.captureScreenshot", format === "png" ? { format, clip, optimizeForSpeed: true } : { format, quality: 95, clip });
        return Buffer.from(shot.data, "base64");
      },
      close: () => context.close(),
    };
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
}
