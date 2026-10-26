import { appendFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  applyBrand,
  applyRedaction,
  CreateTakeSchema,
  defaultEdit,
  EDIT_FILE,
  FinalizeTakeSchema,
  fail,
  type Issue,
  ok,
  parseEvents,
  type Result,
  type Span,
  summarizeTake,
  TAKE_FILE,
  TAKE_TRACKS,
  TAKES_DIR,
  type Take,
  type TakeEdit,
  type TakeEditFile,
  type TakeEvent,
  TakeEventSchema,
  TakeFileSchema,
  type TakeSummary,
  type TakeTrack,
  takeId,
  zodIssues,
} from "../core";
import { extractAudio, posterFrame, probeMedia, remux } from "../export";
import {
  exists,
  Fault,
  loadTake,
  readConfig,
  readSpeech,
  readText,
  resolveInside,
  saveTakeEditWithHistory,
  takeDir,
  toIssues,
  writeText,
} from "../project";

/** Take storage under .clipmunk/takes/<id>/. Uploads append to raw files while recording;
 * finalising remuxes them, extracts the voice track and writes take.json and edit.json.
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

const dirOf = takeDir;
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
    const take = TakeFileSchema.parse({
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
    });
    // The brand and redaction apply once, here; a later change to the config leaves this take as
    // it is. A broken config must not lose a recording, so it is ignored (clipmunk doctor reports
    // it), and the selectors the recording logged boxes for are hidden either way.
    const config = await readConfig(root);
    const settings = config.ok ? config.data.config : undefined;
    const logged = events.flatMap((line) => {
      const event = TakeEventSchema.parse(JSON.parse(line));
      return event.k === "redact" ? [event.sel] : [];
    });
    const edit: TakeEditFile = {
      version: 1,
      edit: withPacing(applyRedaction(applyBrand(defaultEdit(durationMs), settings?.brand), settings, logged)),
    };
    // The edit first: a take is listed once take.json exists, and must then have its edit.
    await writeText(root, `${dir}/${EDIT_FILE}`, `${JSON.stringify(edit, null, 2)}\n`);
    await writeText(root, `${dir}/${TAKE_FILE}`, `${JSON.stringify(take, null, 2)}\n`);
    await rm(path.join(absolute, PENDING), { force: true });
    for (const track of TAKE_TRACKS) expected.delete(`${id}/${track}`);
    // Find the speech now, so the first open of the take does not wait for it.
    await readSpeech(root, { ...take, edit: edit.edit }).catch(() => {});
    return ok({ ...take, edit: edit.edit });
  } catch (error) {
    return fail(toIssues(error, "ingest-failed"));
  }
}

/** New takes play idle gaps and typing faster; takes recorded before pacing keep it off. */
const withPacing = (edit: TakeEdit): TakeEdit => ({
  ...edit,
  pace: { deadAir: { ...edit.pace.deadAir, on: true }, typing: { ...edit.pace.typing, on: true } },
});

export const readTake = (id: string, context: Context) => loadTake(context.root, id);

/** A take for the editor and the exporter's page: the take, its revision, and where its voice has speech. */
export async function readTakeForEditor(
  id: string,
  context: Context,
): Promise<Result<{ take: Take; revision: string; speech: Span[] }>> {
  const loaded = await loadTake(context.root, id);
  if (!loaded.ok) return loaded;
  const speech = await readSpeech(context.root, loaded.data.take).catch(() => []);
  return ok({ ...loaded.data, speech });
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
      if (!(await exists(context.root, `${TAKES_DIR}/${name}/${TAKE_FILE}`))) continue; // still recording, or abandoned
      const result = await readTake(name, context);
      if (result.ok) takes.push(summarizeTake(result.data.take));
      else issues.push(...result.issues);
    }
    return ok({ takes, issues });
  } catch (error) {
    return fail(toIssues(error, "takes-failed"));
  }
}

/** Save an edit to edit.json. `revision` is the one the editor read; a mismatch means someone else changed the take. */
/** Save an edit through the history, so the Studio can undo it. */
export const updateTakeEdit = (
  id: string,
  input: { edit?: unknown; title?: unknown; revision?: unknown },
  context: Context,
) => saveTakeEditWithHistory(context.root, id, input);

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

/** A still of the take for the Studio's library: the screen at its first click, or at a second in.
 * Made once and kept as `poster.png` beside the take, a cache that stays out of git.
 */
export async function takePoster(id: string, context: Context): Promise<string> {
  const loaded = await loadTake(context.root, id);
  if (!loaded.ok) throw new Fault(loaded.issues[0]!.code, loaded.issues[0]!.message);
  const { take } = loaded.data;
  const poster = await resolveInside(context.root, `${dirOf(id)}/poster.png`);
  if (
    await stat(poster).then(
      () => true,
      () => false,
    )
  )
    return poster;
  const events = parseEvents(
    (await readText(context.root, `${dirOf(id)}/${take.source.events.file}`)) ?? "",
    TakeEventSchema,
  );
  const click = events.find((event) => event.k === "down" && event.t >= take.edit.trim.startMs);
  const atMs = Math.max(
    0,
    (click?.t ?? Math.min(take.edit.trim.startMs + 1000, take.source.durationMs / 2)) - take.source.screen.offsetMs,
  );
  const screen = await resolveInside(context.root, `${dirOf(id)}/${take.source.screen.file}`);
  await posterFrame(screen, poster, atMs, { cwd: context.root });
  return poster;
}

export async function ensureTakesDir(context: Context): Promise<void> {
  await mkdir(await resolveInside(context.root, TAKES_DIR), { recursive: true });
}

/** The take's event log, validated line by line. */
export async function readTakeEvents(id: string, context: Context): Promise<TakeEvent[]> {
  return parseEvents((await readText(context.root, `${dirOf(id)}/events.jsonl`)) ?? "", TakeEventSchema);
}
