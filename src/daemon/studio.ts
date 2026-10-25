import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

/** Serving the standalone Studio's static files. They are public, because they hold no project
 * data and the token is needed for everything under /v1. The Host check still applies (DNS
 * rebinding), and no other site may frame the Studio.
 */
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".map": "application/json",
};
const SECURITY = {
  "content-security-policy": "frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

export async function serveStudio(
  request: IncomingMessage,
  response: ServerResponse,
  port: number,
  directory: string | undefined,
): Promise<void> {
  if (request.headers.host !== `127.0.0.1:${port}` && request.headers.host !== `localhost:${port}`) {
    response.writeHead(403, { "content-type": "text/plain", ...SECURITY }).end("Unexpected Host header.");
    return;
  }
  if (!directory) {
    response
      .writeHead(503, { "content-type": "text/plain; charset=utf-8", ...SECURITY })
      .end("The Studio is not built. Run npm run build in the Clipmunk package, or use the installed package.");
    return;
  }
  const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://x").pathname);
  // Only files inside the Studio's folder; anything else is the app itself (it routes by query).
  const target = path.resolve(directory, `.${pathname}`);
  let file = path.join(directory, "index.html");
  if (target.startsWith(directory + path.sep)) {
    const found = await stat(target).catch(() => undefined);
    if (found?.isFile()) file = target;
  }
  const { size } = await stat(file);
  const html = file.endsWith(".html");
  response.writeHead(200, {
    "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
    "content-length": size,
    // Built assets carry a hash in their name; the page itself must always be fresh.
    "cache-control": html ? "no-store" : "public, max-age=31536000, immutable",
    ...SECURITY,
  });
  if (request.method === "HEAD") return void response.end();
  createReadStream(file).pipe(response);
}
