import { randomBytes } from "node:crypto";
import { existsSync, type FSWatcher, watch } from "node:fs";
import { chmod, rm } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_FILE, DAEMON_FILE, type DaemonFile, DEFAULT_DAEMON_PORT } from "../core";
import { Fault, readText, resolveInside, toIssues, writeText } from "../project";
import { createEvents } from "./events";
import { admit } from "./guard";
import { deny, STATUS, send } from "./http";
import { createJobs } from "./jobs";
import { ROUTES } from "./routes";
import { serveStudio } from "./studio";

/** The local daemon: a thin HTTP adapter over the same operations the CLI calls.
 * It listens on 127.0.0.1 only. Every request needs the session token, a loopback
 * Origin (when a browser sends one) and the daemon's own Host, which together stop
 * other websites and DNS rebinding from reaching it. It never executes project code.
 */
export type Daemon = {
  port: number;
  token: string;
  origin: string;
  /** Where the Studio app is served from, when it was found. */
  studio: string | undefined;
  close(): Promise<void>;
};
export type DaemonOptions = {
  root: string;
  port?: number;
  version?: string;
  log?: (line: string) => void;
  /** Write .clipmunk/daemon.json. Off for a second daemon on a project that may already have one (tests). */
  announce?: boolean;
  /** The built Studio app (dist/studio-app). Otherwise CLIPMUNK_STUDIO_DIR, then beside the package's own code. */
  studioDir?: string;
};

/** The Studio app shipped with the package: dist/studio-app, beside dist/cli.js or its chunks. */
function packagedStudio(): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [path.join(here, "studio-app"), path.join(here, "..", "studio-app")].find((dir) =>
    existsSync(path.join(dir, "index.html")),
  );
}

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
  const events = createEvents();
  const jobs = createJobs((job, event) =>
    events.emit({ ...job.meta, type: "job", job: job.id, kind: job.kind, event }),
  );
  const studioDir = options.studioDir ?? process.env.CLIPMUNK_STUDIO_DIR ?? packagedStudio();
  let port = 0;

  async function route(request: IncomingMessage, response: ServerResponse) {
    // The Studio's own files are public: they hold no data, and everything under /v1 needs the token.
    if (!request.url?.startsWith("/v1/") && (request.method === "GET" || request.method === "HEAD"))
      return serveStudio(request, response, port, studioDir);
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
      events,
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

  // The config can change on disk (an editor, git, an agent); tell the Studio.
  let watcher: FSWatcher | undefined;
  let settle: ReturnType<typeof setTimeout> | undefined;
  try {
    watcher = watch(root, (_event, file) => {
      if (file !== CONFIG_FILE) return;
      clearTimeout(settle);
      settle = setTimeout(() => events.emit({ type: "config" }), 50);
    });
  } catch {
    // Without a watcher the Studio still sees changes made through the daemon.
  }

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
    studio: studioDir,
    async close() {
      jobs.cancelAll();
      watcher?.close();
      clearTimeout(settle);
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      // Remove the address file only if it is still ours; a newer daemon may have replaced it.
      if (announce && (await readText(root, DAEMON_FILE))?.includes(token))
        await rm(await resolveInside(root, DAEMON_FILE), { force: true });
    },
  };
}
