import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { exportScene, exportSequence, exportTake, ffmpegVersion } from "../export";
import { deleteSequence, discoverScenes, listSequences, readConfig, readSequence, writeSequence } from "../project";
import { audioFile, removeNarration, setSceneMusic, storeNarration } from "./audio";
import { deny, readBody, readJson, reply, send, serveFile } from "./http";
import type { Jobs } from "./jobs";
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
  version: string;
  log: (line: string) => void;
};
type Handler = (call: Call) => Promise<boolean>;
const handled = (_sent?: unknown) => true;

const status: Handler = async ({ response, method, id, context, version }) => {
  if (method !== "GET") return false;
  const data = { version, project: path.basename(context.root), ffmpeg: !!(await ffmpegVersion()) };
  return handled(send(response, 200, { ok: true, data }));
};

const scenes: Handler = async ({ request, response, url, method, id, action, context }) => {
  if (!id && method === "GET") {
    const catalog = await discoverScenes(context);
    const list = catalog.scenes.map(({ id, title, description }) => ({ id, title, description }));
    return handled(send(response, 200, { ok: true, data: { scenes: list, issues: catalog.issues } }));
  }
  if (!id) return false;
  if (action === "narration" && method === "PUT") {
    const offsetMs = Number(url.searchParams.get("offset")) || 0;
    return handled(reply(response, await storeNarration(id, await readBody(request), offsetMs, context)));
  }
  if (action === "narration" && method === "DELETE")
    return handled(reply(response, await removeNarration(id, context)));
  if (action === "music" && method === "PUT") {
    const body = (await readJson(request)) as { music?: unknown };
    return handled(reply(response, await setSceneMusic(id, body.music, context)));
  }
  return false;
};

const audio: Handler = async ({ request, response, method, id, context }) => {
  if (!id || method !== "GET") return false;
  return handled(await serveFile(request, response, await audioFile(id, context)));
};

const sequences: Handler = async ({ request, response, method, id, context }) => {
  if (!id) return method === "GET" && handled(reply(response, await listSequences(context)));
  if (method === "GET") return handled(reply(response, await readSequence(id, context)));
  if (method === "PUT") return handled(reply(response, await writeSequence(id, await readJson(request), context)));
  if (method === "DELETE") return handled(reply(response, await deleteSequence(id, context)));
  return false;
};

const takes: Handler = async ({ request, response, url, method, id, action, name, context, log }) => {
  if (!id) {
    if (method === "GET") return handled(reply(response, await listTakes(context)));
    if (method === "POST") return handled(reply(response, await createTake(await readJson(request), context), true));
    return false;
  }
  if (!action) {
    if (method === "GET") return handled(reply(response, await readTake(id, context)));
    if (method === "PATCH") {
      const body = (await readJson(request)) as Record<string, unknown>;
      return handled(reply(response, await updateTakeEdit(id, body, context)));
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
    return handled(reply(response, await finalizeTake(id, await readJson(request), context)));
  }
  if (action === "files" && name && method === "GET") {
    return handled(await serveFile(request, response, await takeFile(id, name, context)));
  }
  return false;
};

/** Start an export as a job. The job's progress is read from `/v1/jobs/<id>/events`. */
const exports: Handler = async ({ request, response, method, id, origin, context, jobs, log }) => {
  if (id || method !== "POST") return false;
  const body = (await readJson(request)) as Record<string, unknown>;
  // The studio page is the dev server, so its Origin is the address to render from.
  const target = typeof body.url === "string" ? body.url : origin;
  if (!target) return handled(deny(response, "invalid-request", "Pass the dev server address as url."));
  const work = "sequenceId" in body ? exportSequence : "takeId" in body ? exportTake : exportScene;
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

export const ROUTES: Record<string, Handler> = {
  status,
  config,
  scenes,
  audio,
  sequences,
  takes,
  exports,
  jobs: jobRoutes,
};
