import { randomBytes } from "node:crypto";
import { chmod, rm } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { DAEMON_FILE, type DaemonFile, DEFAULT_DAEMON_PORT } from "../core";
import { Fault, readText, resolveInside, toIssues, writeText } from "../project";
import { admit } from "./guard";
import { deny, STATUS, send } from "./http";
import { createJobs } from "./jobs";
import { ROUTES } from "./routes";

/** The local daemon: a thin HTTP adapter over the same operations the CLI calls.
 * It listens on 127.0.0.1 only. Every request needs the session token, a loopback
 * Origin (when a browser sends one) and the daemon's own Host, which together stop
 * other websites and DNS rebinding from reaching it. It never executes project code.
 */
export type Daemon = { port: number; token: string; origin: string; close(): Promise<void> };
export type DaemonOptions = {
  root: string;
  port?: number;
  version?: string;
  log?: (line: string) => void;
  /** Write .clipmunk/daemon.json. Off for a second daemon on a project that may already have one (tests). */
  announce?: boolean;
};

/** Listen on the given port, or, when none was asked for, on the well-known one with any free port as a fallback. */
async function listen(server: http.Server, requested: number | undefined): Promise<number> {
  const on = (port: number) =>
    new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
  // Prefer the well-known port so bookmarks keep working.
  await on(requested ?? DEFAULT_DAEMON_PORT).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EADDRINUSE" || requested !== undefined) throw error;
    return on(0);
  });
  return (server.address() as { port: number }).port;
}

export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  const { root } = options;
  const token = randomBytes(24).toString("base64url");
  const tokenBytes = Buffer.from(token);
  const jobs = createJobs();
  let port = 0;

  async function route(request: IncomingMessage, response: ServerResponse) {
    const admitted = admit(request, response, port, tokenBytes);
    if (!admitted) return;
    const [version, resource, id, action, name] = admitted.url.pathname
      .split("/")
      .filter(Boolean)
      .map(decodeURIComponent);
    const handler = version === "v1" && resource && Object.hasOwn(ROUTES, resource) ? ROUTES[resource] : undefined;
    const sent = await handler?.({
      request,
      response,
      url: admitted.url,
      origin: admitted.origin,
      method: request.method ?? "GET",
      id,
      action,
      name,
      context: { root },
      jobs,
      version: options.version ?? "dev",
      log: (line) => options.log?.(line),
    });
    if (!sent) deny(response, "not-found", "Unknown route.");
  }

  const server = http.createServer((request, response) => {
    route(request, response).catch((error: unknown) => {
      if (response.headersSent) return void response.end();
      const issues = toIssues(error, "daemon-error");
      send(response, STATUS[issues[0]!.code] ?? (error instanceof Fault ? 400 : 500), { ok: false, issues });
    });
  });
  port = await listen(server, options.port);

  const announce = options.announce ?? true;
  if (announce) {
    const record: DaemonFile = { port, pid: process.pid, token, startedAt: new Date().toISOString() };
    await writeText(root, DAEMON_FILE, `${JSON.stringify(record, null, 2)}\n`);
    await chmod(await resolveInside(root, DAEMON_FILE), 0o600);
  }

  return {
    port,
    token,
    origin: `http://127.0.0.1:${port}`,
    async close() {
      jobs.cancelAll();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      // Remove the address file only if it is still ours; a newer daemon may have replaced it.
      if (announce && (await readText(root, DAEMON_FILE))?.includes(token))
        await rm(await resolveInside(root, DAEMON_FILE), { force: true });
    },
  };
}
