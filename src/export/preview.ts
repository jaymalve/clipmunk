import {
  DAEMON_HASH,
  fail,
  frameUrl,
  ok,
  parseVariant,
  type Result,
  STUDIO_PARAM,
  TAKE_PARAM,
  VARIANT_PARAM,
  variantFrame,
} from "../core";
import { Fault, resolveStudio, toIssues } from "../project";
import { launchBrowser, openClip } from "./browser";
import type { ExportContext } from "./operations";

/** One frame of a clip as a PNG, rendered headless the way export renders it, for an agent to look
 * at (`preview` in `clipmunk mcp`). A scene renders on the host's frame page; a take renders in the
 * daemon's own Studio, so `studio` is the running daemon's address and token.
 */
export async function previewFrame(
  input: { kind: "take" | "scene"; id: string; atMs: number; variant?: string; url?: string },
  context: ExportContext & { studio?: { origin: string; port: number; token: string } },
): Promise<Result<{ png: Buffer; atMs: number }>> {
  let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
  try {
    browser = await launchBrowser();
    if (input.kind === "scene") {
      const studio = await resolveStudio({ url: input.url, sceneId: input.id }, context);
      if (!studio.ok) return studio;
      const url = new URL(frameUrl(new URL(studio.data.url).origin, studio.data.project.studioPath, input.id));
      if (input.variant) url.searchParams.set(VARIANT_PARAM, input.variant);
      const size = variantFrame(studio.data.scene!.definition, parseVariant(input.variant).ratio);
      const clip = await openClip(browser, url.toString(), {
        width: Math.round(size.width),
        height: Math.round(size.height),
      });
      try {
        const atMs = Math.max(0, Math.min(input.atMs, clip.info.durationMs));
        return ok({ png: await clip.frame(atMs, "png"), atMs });
      } finally {
        await clip.close();
      }
    }
    if (!context.studio)
      throw new Fault("studio-missing", "Takes are previewed in the daemon's Studio, which is not available.");
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const editor = new URL(`${context.studio.origin}/`);
    editor.searchParams.set(STUDIO_PARAM, "1");
    editor.searchParams.set(TAKE_PARAM, input.id);
    editor.hash = `${DAEMON_HASH}=${context.studio.port}.${context.studio.token}`;
    await page.goto(editor.toString(), { waitUntil: "load" });
    try {
      await page.waitForFunction(
        () => (window as { __CLIPMUNK__?: { kind?: string } }).__CLIPMUNK__?.kind === "take",
        undefined,
        {
          timeout: 45_000,
        },
      );
    } catch {
      throw new Fault("clip-not-ready", `The take "${input.id}" did not open in the Studio.`);
    }
    const shot = await page.evaluate(async (at) => {
      const bridge = (window as unknown as { __CLIPMUNK__: { durationMs: number; seek(t: number): Promise<void> } })
        .__CLIPMUNK__;
      const time = Math.max(0, Math.min(at, bridge.durationMs));
      await bridge.seek(time);
      const canvas = document.querySelector("[data-clipmunk-chrome]")!.shadowRoot!.querySelector("canvas")!;
      return { data: canvas.toDataURL("image/png").split(",")[1]!, atMs: time };
    }, input.atMs);
    return ok({ png: Buffer.from(shot.data, "base64"), atMs: shot.atMs });
  } catch (error) {
    return fail(toIssues(error, "preview-failed"));
  } finally {
    await browser?.close().catch(() => {});
  }
}
