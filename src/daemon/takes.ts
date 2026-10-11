import { appendFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  CreateTakeSchema,
  defaultEdit,
  FinalizeTakeSchema,
  fail,
  type Issue,
  ok,
  parseEvents,
  type Result,
  summarizeTake,
  TAKE_TRACKS,
  TAKES_DIR,
  type Take,
  TakeEditSchema,
  type TakeEvent,
  TakeEventSchema,
  TakeSchema,
  type TakeSummary,
  type TakeTrack,
  takeId,
  zodIssues,
} from "../core";
import { extractAudio, probeMedia, remux } from "../export";
import { exists, Fault, readText, resolveInside, sha256, toIssues, writeText } from "../project";

/** Take storage under .flick/takes/<id>/. Uploads append to raw files while recording;
 * finalising remuxes them, extracts the voice track and writes take.json.
 */
export type Context = { root: string };
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RAW: Record<TakeTrack, string> = {
  screen: "screen.raw.webm",
  cam: "cam.raw.webm",
  mic: "mic.raw.webm",
  events: "events.jsonl",
};
const MAX_CHUNK = 64 * 1024 * 1024;
const PENDING = "recording.json";

const dirOf = (id: string) => {
  if (!ID.test(id)) throw new Fault("invalid-take", `"${id}" is not a take id.`);
  return `${TAKES_DIR}/${id}`;
};
// Chunks must arrive in order. The expected sequence number lives in memory: a recording
// does not survive a daemon restart, and the recorder is told so by the rejected upload.
const expected = new Map<string, number>();

export async function createTake(input: unknown, context: Context, now = new Date()): Promise<Result<{ id: string }>> {
  const parsed = CreateTakeSchema.safeParse(input);
  if (!parsed.success) return fail(zodIssues(parsed.error, "invalid-take"));
  try {
    let id = takeId(now);
    for (let n = 2; await exists(context.root, dirOf(id)); n++) id = `${takeId(now)}-${n}`;
    await writeText(
      context.root,
      `${dirOf(id)}/${PENDING}`,
      JSON.stringify({ ...parsed.data, createdAt: now.toISOString() }),
    );
    for (const track of TAKE_TRACKS) expected.set(`${id}/${track}`, 0);
    return ok({ id });
  } catch (error) {
    return fail(toIssues(error, "take-failed"));
  }
}

export async function appendChunk(
  id: string,
  track: string,
  seq: number,
  data: Buffer,
  context: Context,
): Promise<Result<{ next: number }>> {
  try {
    if (!TAKE_TRACKS.includes(track as TakeTrack))
      throw new Fault("invalid-track", `Unknown track "${track}". Use one of: ${TAKE_TRACKS.join(", ")}.`);
    if (data.length > MAX_CHUNK) throw new Fault("chunk-too-large", "A chunk may be at most 64 MB.");
    const key = `${id}/${track}`;
    const next = expected.get(key);
    if (next === undefined || !(await exists(context.root, `${dirOf(id)}/${PENDING}`)))
      throw new Fault("not-recording", `Take "${id}" is not being recorded. Start a new recording.`);
    // A retry of a chunk whose response was lost is already stored; accept it without writing twice.
    if (seq < next) return ok({ next });
    if (seq !== next) throw new Fault("out-of-order", `Expected chunk ${next} of ${track}, got ${seq}.`);
    await appendFile(await resolveInside(context.root, `${dirOf(id)}/${RAW[track as TakeTrack]}`), data);
    expected.set(key, next + 1);
    return ok({ next: next + 1 });
  } catch (error) {
    return fail(toIssues(error, "upload-failed"));
  }
}

/** Breadcrumbs from the recorder (start, page lifecycle, failures), kept beside the take for diagnosis. */
export async function appendLog(id: string, text: string, context: Context): Promise<Result<{ id: string }>> {
  try {
    if (!(await exists(context.root, dirOf(id)))) throw new Fault("unknown-take", `No take named "${id}".`);
    const file = await resolveInside(context.root, `${dirOf(id)}/recorder.log`);
    const size = await stat(file).then(
      (info) => info.size,
      () => 0,
    );
    if (size < 256 * 1024)
      await appendFile(file, `${new Date().toISOString()} ${text.replace(/[\r\n]+/g, " ").slice(0, 2000)}\n`);
    return ok({ id });
  } catch (error) {
    return fail(toIssues(error, "log-failed"));
  }
}

export async function finalizeTake(id: string, input: unknown, context: Context): Promise<Result<Take>> {
  const parsed = FinalizeTakeSchema.safeParse(input);
  if (!parsed.success) return fail(zodIssues(parsed.error, "invalid-take"));
  try {
    const { root } = context;
    const dir = dirOf(id);
    const pendingText = await readText(root, `${dir}/${PENDING}`);
    if (pendingText === undefined) throw new Fault("not-recording", `Take "${id}" is not being recorded.`);
    const pending = JSON.parse(pendingText) as {
      title?: string;
      width: number;
      height: number;
      dpr: number;
      background: string;
      createdAt: string;
    };
    const absolute = await resolveInside(root, dir);
    const has = async (file: string) =>
      stat(path.join(absolute, file)).then(
        (info) => info.size > 0,
        () => false,
      );
    if (!(await has(RAW.screen)))
      throw new Fault("empty-recording", "No screen video was received, so there is nothing to save.");

    // Raw MediaRecorder files have no duration or index; a stream copy adds both.
    const finish = async (track: "screen" | "cam" | "mic") => {
      const output = `${track}.webm`;
      await remux(RAW[track], output, absolute);
      await rm(path.join(absolute, RAW[track]), { force: true });
      return { file: output, info: await probeMedia(output, absolute) };
    };
    const screen = await finish("screen");
    if (!screen.info.hasVideo || !screen.info.width || !screen.info.height)
      throw new Fault("ingest-failed", "The screen recording contains no readable video.");
    const cam = parsed.data.cam && (await has(RAW.cam)) ? await finish("cam") : undefined;
    const mic = parsed.data.mic && (await has(RAW.mic)) ? await finish("mic") : undefined;
    const voice = cam?.info.hasAudio
      ? { from: cam.file, offsetMs: parsed.data.cam!.offsetMs }
      : mic?.info.hasAudio
        ? { from: mic.file, offsetMs: parsed.data.mic!.offsetMs }
        : undefined;
    if (voice) await extractAudio(voice.from, "audio.wav", absolute);

    // Keep only well-formed events, so everything downstream can trust the log.
    const lines = ((await readText(root, `${dir}/events.jsonl`)) ?? "").split("\n").filter(Boolean);
    const events = lines.filter((line) => {
      try {
        return TakeEventSchema.safeParse(JSON.parse(line)).success;
      } catch {
        return false;
      }
    });
    await writeText(root, `${dir}/events.jsonl`, events.length ? `${events.join("\n")}\n` : "");

    const durationMs = Math.round(parsed.data.durationMs);
    const take = TakeSchema.parse({
      version: 1,
      id,
      title: pending.title ?? `Take ${pending.createdAt.slice(0, 16).replace("T", " ")}`,
      createdAt: pending.createdAt,
      source: {
        width: pending.width,
        height: pending.height,
        dpr: pending.dpr,
        durationMs,
        background: pending.background,
        screen: {
          file: screen.file,
          offsetMs: 0,
          latencyMs: parsed.data.screen.latencyMs,
          width: screen.info.width,
          height: screen.info.height,
        },
        ...(cam?.info.width && cam.info.height
          ? {
              cam: {
                file: cam.file,
                offsetMs: parsed.data.cam!.offsetMs,
                width: cam.info.width,
                height: cam.info.height,
                hasAudio: cam.info.hasAudio,
              },
            }
          : {}),
        ...(mic ? { mic: { file: mic.file, offsetMs: parsed.data.mic!.offsetMs } } : {}),
        ...(voice ? { audio: { file: "audio.wav", offsetMs: voice.offsetMs } } : {}),
        events: { file: "events.jsonl", count: events.length },
      },
      edit: defaultEdit(durationMs),
    });
    await writeText(root, `${dir}/take.json`, `${JSON.stringify(take, null, 2)}\n`);
    await rm(path.join(absolute, PENDING), { force: true });
    for (const track of TAKE_TRACKS) expected.delete(`${id}/${track}`);
    return ok(take);
  } catch (error) {
    return fail(toIssues(error, "ingest-failed"));
  }
}

export async function readTake(id: string, context: Context): Promise<Result<{ take: Take; revision: string }>> {
  try {
    const text = await readText(context.root, `${dirOf(id)}/take.json`);
    if (text === undefined) throw new Fault("unknown-take", `No take named "${id}".`);
    const parsed = TakeSchema.safeParse(JSON.parse(text));
    if (!parsed.success)
      return fail(
        zodIssues(parsed.error, "invalid-take").map((issue) => ({
          ...issue,
          path: `${dirOf(id)}/take.json: ${issue.path}`,
        })),
      );
    return ok({ take: parsed.data, revision: sha256(text) });
  } catch (error) {
    return fail(toIssues(error, "invalid-take"));
  }
}

export async function listTakes(context: Context): Promise<Result<{ takes: TakeSummary[]; issues: Issue[] }>> {
  try {
    const absolute = await resolveInside(context.root, TAKES_DIR);
    const names = await readdir(absolute, { withFileTypes: true }).then(
      (entries) => entries.filter((entry) => entry.isDirectory() && ID.test(entry.name)).map((entry) => entry.name),
      () => [],
    );
    const takes: TakeSummary[] = [];
    const issues: Issue[] = [];
    for (const name of names.sort().reverse()) {
      if (!(await exists(context.root, `${TAKES_DIR}/${name}/take.json`))) continue; // still recording, or abandoned
      const result = await readTake(name, context);
      if (result.ok) takes.push(summarizeTake(result.data.take));
      else issues.push(...result.issues);
    }
    return ok({ takes, issues });
  } catch (error) {
    return fail(toIssues(error, "takes-failed"));
  }
}

/** Save an edit. `revision` is the hash the editor read; a mismatch means someone else changed the file. */
export async function updateTakeEdit(
  id: string,
  input: { edit?: unknown; title?: unknown; revision?: unknown },
  context: Context,
): Promise<Result<{ take: Take; revision: string }>> {
  const current = await readTake(id, context);
  if (!current.ok) return current;
  if (input.revision !== current.data.revision)
    return fail([
      {
        code: "stale-revision",
        message: "take.json changed since it was loaded. Reload the take and apply the edit again.",
      },
    ]);
  const edit =
    input.edit === undefined
      ? { success: true as const, data: current.data.take.edit }
      : TakeEditSchema.safeParse(input.edit);
  if (!edit.success) return fail(zodIssues(edit.error, "invalid-take"));
  const next = TakeSchema.safeParse({
    ...current.data.take,
    edit: edit.data,
    ...(typeof input.title === "string" ? { title: input.title } : {}),
  });
  if (!next.success) return fail(zodIssues(next.error, "invalid-take"));
  const text = `${JSON.stringify(next.data, null, 2)}\n`;
  await writeText(context.root, `${dirOf(id)}/take.json`, text);
  return ok({ take: next.data, revision: sha256(text) });
}

export async function deleteTake(id: string, context: Context): Promise<Result<{ id: string }>> {
  try {
    const absolute = await resolveInside(context.root, dirOf(id));
    if (!(await exists(context.root, dirOf(id)))) throw new Fault("unknown-take", `No take named "${id}".`);
    await rm(absolute, { recursive: true, force: true });
    for (const track of TAKE_TRACKS) expected.delete(`${id}/${track}`);
    return ok({ id });
  } catch (error) {
    return fail(toIssues(error, "delete-failed"));
  }
}

/** Absolute path of a media file inside a take, or a Fault. Only plain file names are accepted. */
export async function takeFile(id: string, name: string, context: Context): Promise<string> {
  if (!/^[a-z0-9][a-z0-9.-]*$/i.test(name) || name.includes(".."))
    throw new Fault("unknown-file", `"${name}" is not a take file.`);
  const absolute = await resolveInside(context.root, `${dirOf(id)}/${name}`);
  if (
    !(await stat(absolute).then(
      (info) => info.isFile(),
      () => false,
    ))
  )
    throw new Fault("unknown-file", `Take "${id}" has no file named "${name}".`);
  return absolute;
}

export async function ensureTakesDir(context: Context): Promise<void> {
  await mkdir(await resolveInside(context.root, TAKES_DIR), { recursive: true });
}

/** The take's event log, validated line by line. */
export async function readTakeEvents(id: string, context: Context): Promise<TakeEvent[]> {
  return parseEvents((await readText(context.root, `${dirOf(id)}/events.jsonl`)) ?? "", TakeEventSchema);
}
