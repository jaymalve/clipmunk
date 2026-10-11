import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, rm, stat } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { DAEMON_FILE, type DaemonFile, DEFAULT_DAEMON_PORT, type Issue, type Result } from "../core";
import { exportScene, exportSequence, exportTake, ffmpegVersion } from "../export";
import {
  deleteSequence,
  discoverScenes,
  Fault,
  listSequences,
  readSequence,
  readText,
  resolveInside,
  toIssues,
  writeSequence,
  writeText,
} from "../project";
import { audioFile, removeNarration, setSceneMusic, storeNarration } from "./audio";
import { createJobs } from "./jobs";
import {
  appendChunk,
  appendLog,
  createTake,
  deleteTake,
  finalizeTake,
  listTakes,
  readTake,
  takeFile,
  updateTakeEdit,
} from "./takes";

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
  /** Write .flick/daemon.json. Off for a second daemon on a project that may already have one (tests). */
  announce?: boolean;
};

const LOOPBACK_ORIGIN = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/;
const STATUS: Record<string, number> = {
  unauthorized: 401,
  forbidden: 403,
  "not-found": 404,
  "unknown-take": 404,
  "unknown-file": 404,
  "unknown-scene": 404,
  "unknown-job": 404,
  "unknown-sequence": 404,
  "out-of-order": 409,
  "stale-revision": 409,
  "not-recording": 409,
  "output-exists": 409,
  "chunk-too-large": 413,
};
const TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".wav": "audio/wav",
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
};
const MAX_BODY = 64 * 1024 * 1024;

function readBody(request: IncomingMessage, limit = MAX_BODY): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Fault("chunk-too-large", "The request body is too large."));
        request.destroy();
      } else chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}
async function readJson(request: IncomingMessage): Promise<unknown> {
  const body = await readBody(request, 2 * 1024 * 1024);
  if (!body.length) return {};
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new Fault("invalid-json", "The request body is not valid JSON.");
  }
}

export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  const { root } = options;
  const token = randomBytes(24).toString("base64url");
  const tokenBytes = Buffer.from(token);
  const jobs = createJobs();
  const context = { root };
  let port = 0;

  const send = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end(JSON.stringify(body));
  };
  const reply = <T>(response: ServerResponse, result: Result<T>, created = false) =>
    send(response, result.ok ? (created ? 201 : 200) : (STATUS[result.issues[0]?.code ?? ""] ?? 400), result);
  const deny = (response: ServerResponse, code: string, message: string) =>
    send(response, STATUS[code] ?? 400, { ok: false, issues: [{ code, message }] satisfies Issue[] });

  async function route(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    const origin = request.headers.origin;
    // A browser on another site still reaches 127.0.0.1; refuse it before doing anything.
    if (request.headers.host !== `127.0.0.1:${port}` && request.headers.host !== `localhost:${port}`)
      return deny(response, "forbidden", "Unexpected Host header.");
    if (origin !== undefined && !LOOPBACK_ORIGIN.test(origin))
      return deny(response, "forbidden", "Only pages served from this machine may use the Flick daemon.");
    if (origin) {
      response.setHeader("access-control-allow-origin", origin);
      response.setHeader("vary", "Origin");
      response.setHeader("access-control-allow-headers", "authorization, content-type");
      response.setHeader("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE");
      response.setHeader("access-control-allow-private-network", "true");
      response.setHeader("access-control-max-age", "600");
    }
    if (request.method === "OPTIONS") return void response.writeHead(204).end();

    // Media elements and EventSource cannot set headers, so GET also accepts ?token=.
    const header = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1];
    const offered = Buffer.from(header ?? (request.method === "GET" ? (url.searchParams.get("token") ?? "") : ""));
    if (offered.length !== tokenBytes.length || !timingSafeEqual(offered, tokenBytes))
      return deny(response, "unauthorized", "Missing or wrong session token. Open the link that `flick dev` printed.");

    const method = request.method ?? "GET";
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts[0] !== "v1") return deny(response, "not-found", "Unknown route.");
    const [, resource, id, action, name] = parts;

    if (resource === "status" && method === "GET")
      return send(response, 200, {
        ok: true,
        data: { version: options.version ?? "dev", project: path.basename(root), ffmpeg: !!(await ffmpegVersion()) },
      });

    if (resource === "scenes" && id && action === "narration") {
      if (method === "PUT")
        return reply(
          response,
          await storeNarration(id, await readBody(request), Number(url.searchParams.get("offset")) || 0, context),
        );
      if (method === "DELETE") return reply(response, await removeNarration(id, context));
    }
    if (resource === "scenes" && id && action === "music" && method === "PUT")
      return reply(
        response,
        await setSceneMusic(id, ((await readJson(request)) as { music?: unknown }).music, context),
      );
    if (resource === "audio" && id && method === "GET")
      return serveFile(request, response, await audioFile(id, context));
    if (resource === "sequences") {
      if (!id && method === "GET") return reply(response, await listSequences(context));
      if (id && method === "GET") return reply(response, await readSequence(id, context));
      if (id && method === "PUT") return reply(response, await writeSequence(id, await readJson(request), context));
      if (id && method === "DELETE") return reply(response, await deleteSequence(id, context));
    }
    if (resource === "scenes" && !id && method === "GET") {
      const catalog = await discoverScenes(context);
      return send(response, 200, {
        ok: true,
        data: {
          scenes: catalog.scenes.map(({ id, title, description }) => ({ id, title, description })),
          issues: catalog.issues,
        },
      });
    }

    if (resource === "takes") {
      if (!id) {
        if (method === "GET") return reply(response, await listTakes(context));
        if (method === "POST") return reply(response, await createTake(await readJson(request), context), true);
      } else if (!action) {
        if (method === "GET") return reply(response, await readTake(id, context));
        if (method === "PATCH")
          return reply(
            response,
            await updateTakeEdit(id, (await readJson(request)) as Record<string, unknown>, context),
          );
        if (method === "DELETE") return reply(response, await deleteTake(id, context));
      } else if (action === "media" && name && method === "PUT") {
        const seq = Number(url.searchParams.get("seq"));
        if (!Number.isInteger(seq) || seq < 0)
          return deny(response, "invalid-request", "Pass the chunk number as ?seq=<n>.");
        return reply(response, await appendChunk(id, name, seq, await readBody(request), context));
      } else if (action === "log" && method === "PUT") {
        return reply(response, await appendLog(id, (await readBody(request, 16 * 1024)).toString("utf8"), context));
      } else if (action === "finalize" && method === "POST") {
        options.log?.(`ingesting ${id}`);
        return reply(response, await finalizeTake(id, await readJson(request), context));
      } else if (action === "files" && name && method === "GET")
        return serveFile(request, response, await takeFile(id, name, context));
    }

    if (resource === "exports" && method === "POST") {
      const body = (await readJson(request)) as Record<string, unknown>;
      // The studio page is the dev server, so its Origin is the address to render from.
      const target = typeof body.url === "string" ? body.url : origin;
      if (!target) return deny(response, "invalid-request", "Pass the dev server address as url.");
      const work = "sequenceId" in body ? exportSequence : "takeId" in body ? exportTake : exportScene;
      const jobId = jobs.start<unknown>("export", (signal, onProgress) =>
        work({ ...body, url: target }, { root, signal, onProgress }),
      );
      options.log?.(`export job ${jobId} started`);
      return send(response, 202, { ok: true, data: { job: jobId } });
    }
    if (resource === "jobs" && id) {
      if (method === "DELETE")
        return jobs.cancel(id)
          ? send(response, 200, { ok: true, data: { job: id } })
          : deny(response, "unknown-job", "No such job.");
      if (action === "events" && method === "GET") {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive",
        });
        const stop = jobs.subscribe(id, (event) => {
          response.write(`data: ${JSON.stringify(event)}\n\n`);
          if (event.type !== "progress") response.end();
        });
        if (!stop)
          return void response.end(
            `data: ${JSON.stringify({ type: "failed", issues: [{ code: "unknown-job", message: "No such job." }] })}\n\n`,
          );
        request.on("close", stop);
        return;
      }
    }
    return deny(response, "not-found", "Unknown route.");
  }

  async function serveFile(request: IncomingMessage, response: ServerResponse, file: string) {
    const { size } = await stat(file);
    const type = TYPES[path.extname(file)] ?? "application/octet-stream";
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? "");
    if (!range || (!range[1] && !range[2])) {
      response.writeHead(200, {
        "content-type": type,
        "content-length": size,
        "accept-ranges": "bytes",
        "cache-control": "no-store",
      });
      return void createReadStream(file).pipe(response);
    }
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) return void response.writeHead(416, { "content-range": `bytes */${size}` }).end();
    response.writeHead(206, {
      "content-type": type,
      "content-length": end - start + 1,
      "content-range": `bytes ${start}-${end}/${size}`,
      "accept-ranges": "bytes",
      "cache-control": "no-store",
    });
    createReadStream(file, { start, end }).pipe(response);
  }

  const server = http.createServer((request, response) => {
    route(request, response).catch((error: unknown) => {
      if (response.headersSent) return void response.end();
      const issues = toIssues(error, "daemon-error");
      send(response, STATUS[issues[0]!.code] ?? (error instanceof Fault ? 400 : 500), { ok: false, issues });
    });
  });

  const listen = (candidate: number) =>
    new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(candidate, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
  // Prefer the well-known port so bookmarks keep working; fall back to any free one.
  await listen(options.port ?? DEFAULT_DAEMON_PORT).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EADDRINUSE" || options.port !== undefined) throw error;
    return listen(0);
  });
  port = (server.address() as { port: number }).port;

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
