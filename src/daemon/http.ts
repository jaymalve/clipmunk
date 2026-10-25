import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { Issue, Result } from "../core";
import { Fault } from "../project";

/** Plain HTTP plumbing for the daemon: reading bodies, writing JSON, and serving files with
 * range requests. Nothing here knows about takes, scenes or security.
 */
export const STATUS: Record<string, number> = {
  unauthorized: 401,
  forbidden: 403,
  "not-found": 404,
  "unknown-take": 404,
  "unknown-file": 404,
  "unknown-scene": 404,
  "unknown-job": 404,
  "unknown-sequence": 404,
  "unknown-preset": 404,
  "out-of-order": 409,
  "stale-revision": 409,
  "not-recording": 409,
  "output-exists": 409,
  "preset-exists": 409,
  "chunk-too-large": 413,
};
const TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".wav": "audio/wav",
  ".png": "image/png",
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
};
const MAX_BODY = 64 * 1024 * 1024;

export function readBody(request: IncomingMessage, limit = MAX_BODY): Promise<Buffer> {
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

export async function readJson(request: IncomingMessage): Promise<unknown> {
  const body = await readBody(request, 2 * 1024 * 1024);
  if (!body.length) return {};
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new Fault("invalid-json", "The request body is not valid JSON.");
  }
}

export function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

/** Send an operation's result. The HTTP status comes from the first issue's code. */
export function reply<T>(response: ServerResponse, result: Result<T>, created = false): void {
  const status = result.ok ? (created ? 201 : 200) : (STATUS[result.issues[0]?.code ?? ""] ?? 400);
  send(response, status, result);
}

export function deny(response: ServerResponse, code: string, message: string): void {
  send(response, STATUS[code] ?? 400, { ok: false, issues: [{ code, message }] satisfies Issue[] });
}

/** Serve a file, whole or as the byte range the request asks for (media elements seek this way). */
export async function serveFile(request: IncomingMessage, response: ServerResponse, file: string): Promise<void> {
  const { size } = await stat(file);
  const headers = {
    "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
    "accept-ranges": "bytes",
    "cache-control": "no-store",
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? "");
  if (!range || (!range[1] && !range[2])) {
    response.writeHead(200, { ...headers, "content-length": size });
    createReadStream(file).pipe(response);
    return;
  }
  // "bytes=-N" means the last N bytes.
  const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
  const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
  if (start > end || start >= size) {
    response.writeHead(416, { "content-range": `bytes */${size}` }).end();
    return;
  }
  response.writeHead(206, {
    ...headers,
    "content-length": end - start + 1,
    "content-range": `bytes ${start}-${end}/${size}`,
  });
  createReadStream(file, { start, end }).pipe(response);
}
