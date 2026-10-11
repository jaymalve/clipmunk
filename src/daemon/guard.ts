import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { deny } from "./http";

/** Who may talk to the daemon. It listens on 127.0.0.1, but a browser on any website can
 * still reach that address, so every request must pass all of these:
 *  - the Host header is the daemon's own (stops DNS rebinding);
 *  - the Origin, when a browser sends one, is a page served from this machine;
 *  - the session token matches, compared in constant time.
 */
const LOOPBACK_ORIGIN = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/;

export type Admitted = { url: URL; origin: string | undefined };

/** Returns the parsed request if it may proceed. Otherwise the refusal (or the preflight
 * answer) has already been sent and the result is undefined.
 */
export function admit(
  request: IncomingMessage,
  response: ServerResponse,
  port: number,
  token: Buffer,
): Admitted | undefined {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  const origin = request.headers.origin;
  if (request.headers.host !== `127.0.0.1:${port}` && request.headers.host !== `localhost:${port}`) {
    deny(response, "forbidden", "Unexpected Host header.");
    return undefined;
  }
  if (origin !== undefined && !LOOPBACK_ORIGIN.test(origin)) {
    deny(response, "forbidden", "Only pages served from this machine may use the Clipmunk daemon.");
    return undefined;
  }
  if (origin) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("vary", "Origin");
    response.setHeader("access-control-allow-headers", "authorization, content-type");
    response.setHeader("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE");
    response.setHeader("access-control-allow-private-network", "true");
    response.setHeader("access-control-max-age", "600");
  }
  // A preflight carries no credentials; it only learns which headers are allowed.
  if (request.method === "OPTIONS") {
    response.writeHead(204).end();
    return undefined;
  }
  // Media elements and EventSource cannot set headers, so GET also accepts ?token=. Writes never do.
  const header = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1];
  const offered = Buffer.from(header ?? (request.method === "GET" ? (url.searchParams.get("token") ?? "") : ""));
  if (offered.length !== token.length || !timingSafeEqual(offered, token)) {
    deny(response, "unauthorized", "Missing or wrong session token. Open the link that `clipmunk dev` printed.");
    return undefined;
  }
  return { url, origin };
}
