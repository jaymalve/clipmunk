import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { exportJob, exportScene, exportSequence, exportTake, ffmpegVersion } from "../export";
import {
  applyPresetToTake,
  deleteSequence,
  discoverScenes,
  listPresets,
  listSequences,
  readConfig,
  readProject,
  readSequence,
  type SavePresetInput,
  savePreset,
  writeSequence,
} from "../project";
import { applyPresetToScene, audioFile, removeNarration, setSceneMusic, storeNarration } from "./audio";
import type { Events, StudioEvent } from "./events";
import { deny, readBody, readJson, reply, send, serveFile } from "./http";
import type { Jobs } from "./jobs";
import {
  appendChunk,
  appendLog,
  createTake,
  deleteTake,
  finalizeTake,
  listTakes,
  readTakeForEditor,
  takeFile,
  updateTakeEdit,
} from "./takes";

/** The daemon's API, one function per resource. Each is a thin adapter: read the request,
 * call the same operation the CLI calls, send its result. A handler returns false when the
 * method or path is not one of its own, and the caller answers "not found".
 */
export type Call = {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  method: string;
  /** The page that sent the request, when it came from a browser. */
  origin: string | undefined;
  /** Path segments after `/v1/<resource>`: `/v1/takes/<id>/<action>/<name>`. */
  id: string | undefined;
  action: string | undefined;
  name: string | undefined;
  context: { root: string };
  jobs: Jobs;
  events: Events;
  version: string;
  log: (line: string) => void;
};
type Handler = (call: Call) => Promise<boolean>;
const handled = (_sent?: unknown) => true;
/** The result, after telling the Studio about the change when it succeeded. */
const announce = <T extends { ok: boolean }>(events: Events, result: T, event: StudioEvent): T => {
  if (result.ok) events.emit(event);
  return result;
};

const status: Handler = async ({ response, method, id, context, version }) => {
  if (method !== "GET") return false;
  const project = await readProject(context.root).catch(() => undefined);
  const data = {
    version,
    project: path.basename(context.root),
    ffmpeg: !!(await ffmpegVersion()),
    // Where the host app runs, for the Studio's scene previews.
    ...(project ? { devUrl: project.devUrl, studioPath: project.studioPath } : {}),
  };
  return handled(send(response, 200, { ok: true, data }));
};

const scenes: Handler = async ({ request, response, url, method, id, action, context, events }) => {
  if (!id && method === "GET") {
    const catalog = await discoverScenes(context);
    // ?detail=1 adds what the Studio shows: the definition, its snapshot, music and sound.
    const list = url.searchParams.has("detail")
      ? catalog.scenes
      : catalog.scenes.map(({ id, title, description }) => ({ id, title, description }));
    return handled(send(response, 200, { ok: true, data: { scenes: list, issues: catalog.issues } }));
  }
  if (!id) return false;
  if (action === "narration" && method === "PUT") {
    const offsetMs = Number(url.searchParams.get("offset")) || 0;
    const result = await storeNarration(id, await readBody(request), offsetMs, context);
    return handled(reply(response, announce(events, result, { type: "edit", kind: "scene", id })));
  }
  if (action === "narration" && method === "DELETE")
    return handled(
      reply(response, announce(events, await removeNarration(id, context), { type: "edit", kind: "scene", id })),
    );
  if (action === "music" && method === "PUT") {
    const body = (await readJson(request)) as { music?: unknown };
    const result = await setSceneMusic(id, body.music, context);
    return handled(reply(response, announce(events, result, { type: "edit", kind: "scene", id })));
  }
  if (action === "preset" && method === "POST") {
    const body = (await readJson(request)) as { name?: unknown };
    const result = await applyPresetToScene(id, String(body.name ?? ""), context);
    return handled(reply(response, announce(events, result, { type: "edit", kind: "scene", id })));
  }
  return false;
};

const audio: Handler = async ({ request, response, method, id, context }) => {
  if (!id || method !== "GET") return false;
  return handled(await serveFile(request, response, await audioFile(id, context)));
};

const sequences: Handler = async ({ request, response, method, id, context, events }) => {
  if (!id) return method === "GET" && handled(reply(response, await listSequences(context)));
  if (method === "GET") return handled(reply(response, await readSequence(id, context)));
  if (method === "PUT") {
    const result = await writeSequence(id, await readJson(request), context);
    return handled(reply(response, announce(events, result, { type: "edit", kind: "sequence", id })));
  }
  if (method === "DELETE") return handled(reply(response, await deleteSequence(id, context)));
  return false;
};

const takes: Handler = async ({ request, response, url, method, id, action, name, context, log, events }) => {
  if (!id) {
    if (method === "GET") return handled(reply(response, await listTakes(context)));
    if (method === "POST") return handled(reply(response, await createTake(await readJson(request), context), true));
    return false;
  }
  if (!action) {
    if (method === "GET") return handled(reply(response, await readTakeForEditor(id, context)));
    if (method === "PATCH") {
      const body = (await readJson(request)) as Record<string, unknown>;
      const result = await updateTakeEdit(id, body, context);
      return handled(reply(response, announce(events, result, { type: "edit", kind: "take", id })));
    }
    if (method === "DELETE") return handled(reply(response, await deleteTake(id, context)));
    return false;
  }
  if (action === "media" && name && method === "PUT") {
    const seq = Number(url.searchParams.get("seq"));
    if (!Number.isInteger(seq) || seq < 0)
      return handled(deny(response, "invalid-request", "Pass the chunk number as ?seq=<n>."));
    return handled(reply(response, await appendChunk(id, name, seq, await readBody(request), context)));
  }
  if (action === "log" && method === "PUT") {
    const text = (await readBody(request, 16 * 1024)).toString("utf8");
    return handled(reply(response, await appendLog(id, text, context)));
  }
  if (action === "finalize" && method === "POST") {
    log(`ingesting ${id}`);
    const result = await finalizeTake(id, await readJson(request), context);
    return handled(reply(response, announce(events, result, { type: "take", id })));
  }
  if (action === "preset" && method === "POST") {
    const body = (await readJson(request)) as { name?: unknown };
    const result = await applyPresetToTake(context.root, id, String(body.name ?? ""));
    return handled(reply(response, announce(events, result, { type: "edit", kind: "take", id })));
  }
  if (action === "files" && name && method === "GET") {
    return handled(await serveFile(request, response, await takeFile(id, name, context)));
  }
  return false;
};

/** Start an export as a job. The job's progress is read from `/v1/jobs/<id>/events`. */
const exports: Handler = async ({ request, response, url, method, id, origin, context, jobs, log }) => {
  if (id || method !== "POST") return false;
  const body = (await readJson(request)) as Record<string, unknown>;
  // The in-app studio page is the dev server, so its Origin is the address to render from. The
  // standalone Studio is served by the daemon itself; then the project's own dev server is.
  const own = origin === `http://${url.host}` || origin === `http://127.0.0.1:${url.port}`;
  const project = own ? await readProject(context.root).catch(() => undefined) : undefined;
  const target = typeof body.url === "string" ? body.url : own ? project?.devUrl : origin;
  if (!target) return handled(deny(response, "invalid-request", "Pass the dev server address as url."));
  // A job with several outputs names its clip; the older single-file shape names the clip by kind.
  const work =
    "clip" in body ? exportJob : "sequenceId" in body ? exportSequence : "takeId" in body ? exportTake : exportScene;
  const job = jobs.start<unknown>("export", (signal, onProgress) =>
    work({ ...body, url: target }, { root: context.root, signal, onProgress }),
  );
  log(`export job ${job} started`);
  return handled(send(response, 202, { ok: true, data: { job } }));
};

const jobRoutes: Handler = async ({ request, response, method, id, action, jobs }) => {
  if (!id) return false;
  if (method === "DELETE") {
    if (jobs.cancel(id)) return handled(send(response, 200, { ok: true, data: { job: id } }));
    return handled(deny(response, "unknown-job", "No such job."));
  }
  if (action !== "events" || method !== "GET") return false;
  // Server-sent events: the latest progress at once, then each update until the job ends.
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  const stop = jobs.subscribe(id, (event) => {
    response.write(`data: ${JSON.stringify(event)}\n\n`);
    if (event.type !== "progress") response.end();
  });
  if (stop) request.on("close", stop);
  else {
    const failed = { type: "failed", issues: [{ code: "unknown-job", message: "No such job." }] };
    response.end(`data: ${JSON.stringify(failed)}\n\n`);
  }
  return true;
};

/** The project's clipmunk.config.json, validated; the empty config when there is none. */
const config: Handler = async ({ response, method, id, context }) => {
  if (method !== "GET" || id) return false;
  const result = await readConfig(context.root);
  return handled(reply(response, result.ok ? { ok: true, data: result.data } : result));
};

/** List presets, or save one: `{ name, preset }` or `{ name, fromTake, fields }`, with `replace` to overwrite. */
const presets: Handler = async ({ request, response, method, id, context }) => {
  if (id) return false;
  if (method === "GET") return handled(reply(response, await listPresets(context.root)));
  if (method === "POST") {
    const body = (await readJson(request)) as SavePresetInput;
    return handled(reply(response, await savePreset(context.root, body), true));
  }
  return false;
};

/** One server-sent-events stream of everything the Studio should hear (events.ts). */
const eventStream: Handler = async ({ request, response, method, id, events }) => {
  if (id || method !== "GET") return false;
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  response.write(": connected\n\n");
  const stop = events.subscribe((event) => response.write(`data: ${JSON.stringify(event)}\n\n`));
  // A comment now and then keeps proxies and the browser from closing an idle stream.
  const beat = setInterval(() => response.write(": beat\n\n"), 25_000);
  request.on("close", () => {
    clearInterval(beat);
    stop();
  });
  return true;
};

export const ROUTES: Record<string, Handler> = {
  events: eventStream,
  status,
  config,
  presets,
  scenes,
  audio,
  sequences,
  takes,
  exports,
  jobs: jobRoutes,
};
