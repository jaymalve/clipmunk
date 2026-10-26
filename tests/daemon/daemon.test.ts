import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Daemon, startDaemon } from "../../src/daemon";
import { readTakeFiles } from "../support/take";

/** The daemon over real HTTP: its security rules, then a whole recording from first chunk to take.json and edit.json. */
const ffmpeg = path.resolve("node_modules/ffmpeg-static/ffmpeg");
let root: string, daemon: Daemon, screen: Buffer, cam: Buffer;
const ORIGIN = "http://localhost:5173";

type Options = {
  method?: string;
  body?: unknown;
  raw?: Buffer;
  token?: string | null;
  origin?: string | null;
  headers?: Record<string, string>;
};
async function call(route: string, options: Options = {}) {
  const headers: Record<string, string> = { ...options.headers };
  if (options.token !== null) headers.authorization = `Bearer ${options.token ?? daemon.token}`;
  if (options.origin !== null) headers.origin = options.origin ?? ORIGIN;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${daemon.origin}${route}`, {
    method: options.method ?? "GET",
    headers,
    body: options.raw
      ? new Uint8Array(options.raw)
      : options.body === undefined
        ? undefined
        : JSON.stringify(options.body),
  });
  return {
    status: response.status,
    headers: response.headers,
    json: response.headers.get("content-type")?.includes("json") ? ((await response.json()) as any) : undefined,
    response,
  };
}

beforeAll(async () => {
  process.env.CLIPMUNK_FFMPEG ??= ffmpeg;
  root = await mkdtemp(path.join(os.tmpdir(), "clipmunk-daemon-"));
  await writeFile(path.join(root, "package.json"), "{}");
  // Stand-ins for MediaRecorder output: VP8 video, and VP8 + Opus for the camera.
  const make = (name: string, args: string[]) =>
    execFileSync(ffmpeg, ["-y", "-loglevel", "error", ...args, path.join(root, name)]);
  make("screen-src.webm", ["-f", "lavfi", "-i", "testsrc=s=320x200:r=30:d=2", "-c:v", "libvpx", "-b:v", "300k"]);
  make("cam-src.webm", [
    "-f",
    "lavfi",
    "-i",
    "testsrc=s=160x120:r=30:d=2",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=2",
    "-c:v",
    "libvpx",
    "-c:a",
    "libopus",
    "-shortest",
  ]);
  screen = await readFile(path.join(root, "screen-src.webm"));
  cam = await readFile(path.join(root, "cam-src.webm"));
  daemon = await startDaemon({ root, port: 0 });
}, 60_000);
afterAll(async () => {
  await daemon?.close();
  await rm(root, { recursive: true, force: true });
});

describe("daemon security", () => {
  it("records its address for the CLI and removes it on close", async () => {
    const file = JSON.parse(await readFile(path.join(root, ".clipmunk/daemon.json"), "utf8"));
    expect(file).toMatchObject({ port: daemon.port, token: daemon.token, pid: process.pid });
    const other = await mkdtemp(path.join(os.tmpdir(), "clipmunk-daemon-close-"));
    const second = await startDaemon({ root: other, port: 0 });
    expect(existsSync(path.join(other, ".clipmunk/daemon.json"))).toBe(true);
    await second.close();
    expect(existsSync(path.join(other, ".clipmunk/daemon.json"))).toBe(false);
    await rm(other, { recursive: true, force: true });
  });

  it("requires the session token", async () => {
    expect((await call("/v1/status", { token: null })).status).toBe(401);
    expect((await call("/v1/status", { token: "x".repeat(daemon.token.length) })).status).toBe(401);
    expect((await call(`/v1/status?token=${daemon.token}`, { token: null })).status).toBe(200);
    // The query token is for media elements only: it never authorises a write.
    expect((await call(`/v1/takes?token=${daemon.token}`, { token: null, method: "POST", body: {} })).status).toBe(401);
    const ok = await call("/v1/status");
    expect(ok.json).toMatchObject({ ok: true, data: { ffmpeg: true } });
  });

  it("refuses other websites and unexpected hosts, and answers preflight for local pages", async () => {
    expect((await call("/v1/status", { origin: "https://evil.example" })).status).toBe(403);
    // fetch will not send a forged Host, so speak HTTP directly, as a rebinding attack would.
    const forged = await new Promise<number>((resolve, reject) =>
      http
        .get(
          {
            host: "127.0.0.1",
            port: daemon.port,
            path: "/v1/status",
            headers: { host: "evil.example", authorization: `Bearer ${daemon.token}` },
          },
          (response) => resolve(response.statusCode!),
        )
        .on("error", reject),
    );
    expect(forged).toBe(403);
    expect((await call("/v1/status", { origin: null })).status).toBe(200); // the CLI sends no Origin
    const preflight = await call("/v1/takes", { method: "OPTIONS", token: null });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(preflight.headers.get("access-control-allow-headers")).toContain("authorization");
  });

  it("keeps every path inside the takes directory", async () => {
    expect((await call("/v1/takes/..%2F..%2Fetc")).status).toBe(400);
    expect((await call("/v1/takes/Not_A_Slug")).status).toBe(400);
    expect((await call("/v1/takes/missing")).status).toBe(404);
    expect((await call("/v1/takes/missing/files/..%2F..%2Fpackage.json")).status).toBe(404);
    expect((await call("/v1/nope")).status).toBe(404);
  });
});

describe("recording a take", () => {
  let id: string;

  it("creates a take and accepts chunks only in order", async () => {
    const bad = await call("/v1/takes", { method: "POST", body: { width: -1 } });
    expect(bad.status).toBe(400);
    const created = await call("/v1/takes", {
      method: "POST",
      body: { width: 1280, height: 720, dpr: 2, background: "rgb(255, 255, 255)" },
    });
    expect(created.status).toBe(201);
    id = created.json.data.id;
    expect(id).toMatch(/^take-\d{8}-\d{6}/);
    expect((await call("/v1/takes")).json.data.takes).toEqual([]); // not listed until finalised

    const cut = Math.floor(screen.length / 2);
    expect(
      (await call(`/v1/takes/${id}/media/screen?seq=1`, { method: "PUT", raw: screen.subarray(cut) })).status,
    ).toBe(409);
    expect(
      (await call(`/v1/takes/${id}/media/screen?seq=0`, { method: "PUT", raw: screen.subarray(0, cut) })).json,
    ).toMatchObject({ ok: true, data: { next: 1 } });
    // A retry of a chunk that is already stored (its response was lost) is accepted and not written twice.
    expect(
      (await call(`/v1/takes/${id}/media/screen?seq=0`, { method: "PUT", raw: screen.subarray(0, cut) })).json,
    ).toMatchObject({ ok: true, data: { next: 1 } });
    expect((await stat(path.join(root, `.clipmunk/takes/${id}/screen.raw.webm`))).size).toBe(cut);
    expect(
      (await call(`/v1/takes/${id}/log`, { method: "PUT", raw: Buffer.from("start 1280x720\nsecond line") })).status,
    ).toBe(200);
    expect(await readFile(path.join(root, `.clipmunk/takes/${id}/recorder.log`), "utf8")).toMatch(
      /^\d{4}-.*Z start 1280x720 second line\n$/,
    );
    expect((await call("/v1/takes/missing/log", { method: "PUT", raw: Buffer.from("x") })).status).toBe(404);
    expect(
      (await call(`/v1/takes/${id}/media/screen?seq=1`, { method: "PUT", raw: screen.subarray(cut) })).status,
    ).toBe(200);
    expect((await call(`/v1/takes/${id}/media/cam?seq=0`, { method: "PUT", raw: cam })).status).toBe(200);
    expect((await call(`/v1/takes/${id}/media/secrets?seq=0`, { method: "PUT", raw: cam })).status).toBe(400);

    const events = [
      { t: 0, k: "resize", width: 1280, height: 720 },
      { t: 120, k: "move", x: 100, y: 80 },
      { t: 400, k: "down", x: 100, y: 80, button: 0, rect: [60, 60, 120, 40] },
      { t: 480, k: "up", x: 100, y: 80, button: 0 },
      { t: 900, k: "type", rect: [60, 200, 300, 36] },
    ];
    const lines = `${events.map((event) => JSON.stringify(event)).join("\n")}\n{"t":950,"k":"type","rect":[0,0,1,1],"key":"p"}\nnot json\n`;
    expect((await call(`/v1/takes/${id}/media/events?seq=0`, { method: "PUT", raw: Buffer.from(lines) })).status).toBe(
      200,
    );
  });

  it("finalises into a valid take with seekable media and a clean event log", async () => {
    const done = await call(`/v1/takes/${id}/finalize`, {
      method: "POST",
      body: { durationMs: 2000, screen: { latencyMs: 35 }, cam: { offsetMs: 12, hasAudio: true } },
    });
    expect(done.json.issues).toBeUndefined();
    const take = await readTakeFiles(path.join(root, `.clipmunk/takes/${id}`));
    if (!take.ok) throw new Error(JSON.stringify(take.issues));
    // The recording and its edit are separate files; the recording carries no edit.
    expect(JSON.parse(await readFile(path.join(root, `.clipmunk/takes/${id}/take.json`), "utf8"))).not.toHaveProperty(
      "edit",
    );
    expect(take.data.source).toMatchObject({
      width: 1280,
      height: 720,
      dpr: 2,
      durationMs: 2000,
      screen: { file: "screen.webm", latencyMs: 35, width: 320, height: 200 },
      cam: { file: "cam.webm", offsetMs: 12, width: 160, height: 120, hasAudio: true },
      audio: { file: "audio.wav", offsetMs: 12 },
      events: { file: "events.jsonl", count: 5 }, // the line carrying a key and the junk line are dropped
    });
    expect(take.data.edit).toMatchObject({
      trim: { startMs: 0, endMs: 2000 },
      zoom: { mode: "auto" },
      canvas: { width: 1920, height: 1080 },
    });
    const log = await readFile(path.join(root, `.clipmunk/takes/${id}/events.jsonl`), "utf8");
    expect(log).not.toContain('"key"');
    expect(existsSync(path.join(root, `.clipmunk/takes/${id}/screen.raw.webm`))).toBe(false);
    expect(existsSync(path.join(root, `.clipmunk/takes/${id}/recording.json`))).toBe(false);
    // The remuxed file reports a duration, which a raw MediaRecorder file never does.
    expect(
      execFileSync(
        ffmpeg,
        ["-hide_banner", "-i", path.join(root, `.clipmunk/takes/${id}/screen.webm`), "-f", "null", "-"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ),
    ).toBe("");
    expect((await call(`/v1/takes/${id}/media/screen?seq=2`, { method: "PUT", raw: screen })).status).toBe(409); // recording is over
  }, 60_000);

  it("lists, serves ranges, saves edits against a revision and deletes", async () => {
    const list = await call("/v1/takes");
    expect(list.json.data.takes).toMatchObject([
      { id, durationMs: 2000, width: 320, height: 200, hasCam: true, hasAudio: true },
    ]);

    const whole = await call(`/v1/takes/${id}/files/screen.webm?token=${daemon.token}`, { token: null });
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-type")).toBe("video/webm");
    const part = await call(`/v1/takes/${id}/files/screen.webm`, { headers: { range: "bytes=10-19" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toMatch(/^bytes 10-19\/\d+$/);
    expect((await part.response.arrayBuffer()).byteLength).toBe(10);
    expect((await call(`/v1/takes/${id}/files/take.txt`)).status).toBe(404);

    const read = await call(`/v1/takes/${id}`);
    const record = await readFile(path.join(root, `.clipmunk/takes/${id}/take.json`), "utf8");
    const edit = { ...read.json.data.take.edit, trim: { startMs: 200, endMs: 1500 }, cursor: { size: 2 } };
    expect((await call(`/v1/takes/${id}`, { method: "PATCH", body: { edit, revision: "stale" } })).status).toBe(409);
    const saved = await call(`/v1/takes/${id}`, { method: "PATCH", body: { edit, revision: read.json.data.revision } });
    expect(saved.json.data.take.edit).toMatchObject({
      trim: { startMs: 200, endMs: 1500 },
      cursor: { size: 2, visible: true },
    });
    expect(saved.json.data.revision).not.toBe(read.json.data.revision);
    expect(await readFile(path.join(root, `.clipmunk/takes/${id}/take.json`), "utf8")).toBe(record);
    expect(JSON.parse(await readFile(path.join(root, `.clipmunk/takes/${id}/edit.json`), "utf8")).edit).toMatchObject({
      trim: { startMs: 200, endMs: 1500 },
    });
    const invalid = await call(`/v1/takes/${id}`, {
      method: "PATCH",
      body: { edit: { ...edit, trim: { startMs: 0, endMs: 99999 } }, revision: saved.json.data.revision },
    });
    expect(invalid.status).toBe(400);

    expect((await call(`/v1/takes/${id}`, { method: "DELETE" })).status).toBe(200);
    expect(existsSync(path.join(root, `.clipmunk/takes/${id}`))).toBe(false);
    expect((await call(`/v1/takes/${id}`)).status).toBe(404);
  });

  it("keeps the recording when saving fails, so the save can be retried", async () => {
    const created = await call("/v1/takes", {
      method: "POST",
      body: { width: 800, height: 600, dpr: 1, background: "#fff" },
    });
    const takeId = created.json.data.id;
    await call(`/v1/takes/${takeId}/media/screen?seq=0`, { method: "PUT", raw: screen });
    const body = { durationMs: 2000, screen: { latencyMs: 0 } };
    const real = process.env.CLIPMUNK_FFMPEG;
    process.env.CLIPMUNK_FFMPEG = "/nonexistent/ffmpeg";
    try {
      expect((await call("/v1/status")).json.data.ffmpeg).toBe(false);
      const failed = await call(`/v1/takes/${takeId}/finalize`, { method: "POST", body });
      expect(failed.json).toMatchObject({ ok: false, issues: [{ code: "missing-ffmpeg" }] });
      expect(failed.json.issues[0].message).toContain("ffmpeg-static");
    } finally {
      process.env.CLIPMUNK_FFMPEG = real;
    }
    expect(existsSync(path.join(root, `.clipmunk/takes/${takeId}/screen.raw.webm`))).toBe(true);
    const retried = await call(`/v1/takes/${takeId}/finalize`, { method: "POST", body });
    expect(retried.json).toMatchObject({ ok: true, data: { id: takeId, source: { durationMs: 2000 } } });
    await call(`/v1/takes/${takeId}`, { method: "DELETE" });
  }, 60_000);

  it("refuses to save a recording with no screen video", async () => {
    const created = await call("/v1/takes", {
      method: "POST",
      body: { width: 800, height: 600, dpr: 1, background: "#fff" },
    });
    const empty = await call(`/v1/takes/${created.json.data.id}/finalize`, {
      method: "POST",
      body: { durationMs: 10, screen: { latencyMs: 0 } },
    });
    expect(empty.json).toMatchObject({ ok: false, issues: [{ code: "empty-recording" }] });
  });
});

describe("export jobs", () => {
  it("reports an unknown scene through the job stream and rejects unknown jobs", async () => {
    const started = await call("/v1/exports", { method: "POST", body: { sceneId: "nope" } });
    expect(started.status).toBe(202);
    const stream = await fetch(`${daemon.origin}/v1/jobs/${started.json.data.job}/events?token=${daemon.token}`);
    const text = await stream.text();
    expect(text).toContain('"type":"failed"');
    expect(text).toMatch(/not-initialized|unknown-scene/);
    expect(await (await fetch(`${daemon.origin}/v1/jobs/unknown/events?token=${daemon.token}`)).text()).toContain(
      "unknown-job",
    );
    expect((await call("/v1/jobs/unknown", { method: "DELETE" })).status).toBe(404);
  });
});
