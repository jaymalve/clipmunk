import {
  DAEMON_FILE,
  DaemonFileSchema,
  diffJson,
  formatChanges,
  type Issue,
  mergePatch,
  motionDuration,
  parseEvents,
  summarizeEvents,
  type TakeEvent,
  TakeEventSchema,
} from "../core";
import { readText } from "../project";
import type { Tool, ToolResult } from "./server";

/** The tools `clipmunk mcp` offers an agent. Each one calls a route of the running daemon and
 * formats the answer; the logic stays in the daemon, so the Studio, the CLI and the agent agree.
 */
type Reply<T> = { ok: true; data: T } | { ok: false; issues: Issue[] };
type Clip = { kind: "take" | "scene" | "sequence"; id: string; title: string; durationMs?: number };

export function daemonClient(root: string) {
  async function link() {
    let parsed: ReturnType<typeof DaemonFileSchema.safeParse> | undefined;
    try {
      parsed = DaemonFileSchema.safeParse(JSON.parse((await readText(root, DAEMON_FILE)) ?? "null"));
    } catch {
      parsed = undefined;
    }
    if (!parsed?.success)
      throw new Error("The Clipmunk daemon is not running. Start it in this project with: npx clipmunk dev");
    return parsed.data;
  }
  async function request<T>(method: string, route: string, body?: unknown): Promise<Reply<T>> {
    const { port, token } = await link();
    let response: Response;
    try {
      response = await fetch(`http://127.0.0.1:${port}${route}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new Error(`Nothing answers at 127.0.0.1:${port}. Start the daemon with: npx clipmunk dev`);
    }
    if ((response.headers.get("content-type") ?? "").startsWith("image/"))
      return {
        ok: true,
        data: {
          png: Buffer.from(await response.arrayBuffer()),
          atMs: Number(response.headers.get("x-clipmunk-at")),
        } as T,
      };
    if ((response.headers.get("content-type") ?? "").startsWith("application/json"))
      return (await response.json()) as Reply<T>;
    return { ok: true, data: (await response.text()) as T };
  }
  return {
    get: <T>(route: string) => request<T>("GET", route),
    post: <T>(route: string, body: unknown) => request<T>("POST", route, body),
    patch: <T>(route: string, body: unknown) => request<T>("PATCH", route, body),
  };
}
type Client = ReturnType<typeof daemonClient>;

const text = (value: string): ToolResult => ({ content: [{ type: "text", text: value }] });
const json = (value: unknown) => JSON.stringify(value, null, 2);
/** A daemon answer, or the tool's error result with the daemon's own explanation. */
function unwrap<T>(reply: Reply<T>): T {
  if (!reply.ok)
    throw new Error(
      reply.issues.map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message)).join("\n"),
    );
  return reply.data;
}
const string = (description: string) => ({ type: "string", description });
const idArg = { id: string("The clip's id, as list_clips shows it.") };

async function listClips(client: Client): Promise<Clip[]> {
  const takes = unwrap(
    await client.get<{ takes: { id: string; title: string; durationMs: number }[] }>("/v1/takes"),
  ).takes;
  const scenes = unwrap(
    await client.get<{ scenes: { id: string; title: string; definition: { motion?: never } }[] }>(
      "/v1/scenes?detail=1",
    ),
  ).scenes;
  const sequences = unwrap(await client.get<{ sequences: { id: string; title: string }[] }>("/v1/sequences")).sequences;
  return [
    ...takes.map((take) => ({ kind: "take" as const, id: take.id, title: take.title, durationMs: take.durationMs })),
    ...scenes.map((scene) => ({
      kind: "scene" as const,
      id: scene.id,
      title: scene.title,
      durationMs: scene.definition.motion ? motionDuration(scene.definition.motion) : 0,
    })),
    ...sequences.map((sequence) => ({ kind: "sequence" as const, id: sequence.id, title: sequence.title })),
  ];
}
async function kindOf(client: Client, id: string, wanted?: unknown): Promise<Clip["kind"]> {
  if (wanted === "take" || wanted === "scene" || wanted === "sequence") return wanted;
  const clip = (await listClips(client)).find((candidate) => candidate.id === id);
  if (!clip) throw new Error(`No clip named "${id}". list_clips shows them all.`);
  return clip.kind;
}
const kindArg = {
  kind: {
    type: "string",
    enum: ["take", "scene", "sequence"],
    description: "Only needed when a take and a scene share an id.",
  },
};

async function readTake(client: Client, id: string) {
  const data = unwrap(
    await client.get<{
      take: { edit: Record<string, unknown>; title: string; source: { durationMs: number; events: { file: string } } };
      revision: string;
    }>(`/v1/takes/${id}`),
  );
  const log = unwrap(await client.get<string>(`/v1/takes/${id}/files/${data.take.source.events.file}`));
  const events = parseEvents(typeof log === "string" ? log : "", TakeEventSchema) as TakeEvent[];
  return { ...data, events };
}

type ChatContext =
  | { kind: "clip"; clip: { kind: string; id: string } }
  | { kind: "time"; ms: number }
  | { kind: "element"; sel: string; name?: string; role?: string }
  | { kind: "component"; file: string };
type ChatMessage = { id: string; text: string; context?: ChatContext[] };

/** A developer's chat message as the agent reads it: the words, then what they pointed at. */
export function formatChatMessage(message: ChatMessage): string {
  const lines = [`The developer says (message ${message.id}):`, message.text];
  const context = message.context ?? [];
  if (context.length) lines.push("", "About:");
  for (const item of context) {
    if (item.kind === "clip")
      lines.push(`  ${item.clip.kind} ${item.clip.id}${item.clip.kind === "take" ? " (get_take to read it)" : ""}`);
    // For a take, on the recording's clock, like the times get_take shows.
    else if (item.kind === "time") lines.push(`  the moment at ${(item.ms / 1000).toFixed(2)} s`);
    else if (item.kind === "element")
      lines.push(`  the element ${item.sel}${item.name ? ` "${item.name}"` : ""}${item.role ? ` (${item.role})` : ""}`);
    else lines.push(`  the component ${item.file}`);
  }
  lines.push("", "Answer with reply_chat, then call wait_for_chat again.");
  return lines.join("\n");
}

/** A take's key moments on the recording's clock: each click in the kept range, a second apart
 * at least, or its start when nothing was clicked. */
function keyMoments(events: readonly TakeEvent[], trim: { startMs: number; endMs: number }): number[] {
  const times: number[] = [];
  for (const event of events)
    if (
      event.k === "down" &&
      event.t >= trim.startMs &&
      event.t <= trim.endMs &&
      !(event.t - (times.at(-1) ?? -Infinity) < 1000)
    )
      times.push(event.t);
  return times.length ? times : [trim.startMs];
}

export function clipmunkTools(root: string): Tool[] {
  const client = daemonClient(root);
  return [
    {
      name: "list_clips",
      description: "List every take (recording), scene and sequence in the project, with its id and length.",
      inputSchema: { type: "object", properties: {} },
      async call() {
        const clips = await listClips(client);
        if (!clips.length) return text("No clips yet. Record a take (Alt+Shift+R in the app) or write a scene.");
        return text(
          clips
            .map(
              (clip) =>
                `${clip.kind} ${clip.id}: ${clip.title}${clip.durationMs !== undefined ? ` (${(clip.durationMs / 1000).toFixed(1)} s)` : ""}`,
            )
            .join("\n"),
        );
      },
    },
    {
      name: "get_take",
      description:
        "Read a take: its edit (what edit_take changes), its revision, and a summary of what happened in it (pages, clicks with the element's role, name and selector, typing, shortcuts), with times on the recording's clock.",
      inputSchema: { type: "object", properties: idArg, required: ["id"] },
      async call(args) {
        const take = await readTake(client, String(args.id));
        return text(
          [
            `${take.take.title}: ${(take.take.source.durationMs / 1000).toFixed(2)} s, revision ${take.revision}`,
            "",
            "What happened:",
            ...(summarizeEvents(take.events).map((line) => `  ${line}`) || []),
            "",
            "Edit (change it with edit_take and a JSON merge patch):",
            json(take.take.edit),
          ].join("\n"),
        );
      },
    },
    {
      name: "get_scene",
      description:
        "Read a scene: its recipe (camera, nodes, motion, variants, music) and the component file that renders it.",
      inputSchema: { type: "object", properties: idArg, required: ["id"] },
      async call(args) {
        const scenes = unwrap(
          await client.get<{ scenes: { id: string; binding: string; [key: string]: unknown }[] }>(
            "/v1/scenes?detail=1",
          ),
        ).scenes;
        const scene = scenes.find((candidate) => candidate.id === args.id);
        if (!scene) throw new Error(`No scene named "${String(args.id)}".`);
        const { binding, ...recipe } = scene;
        return text(`Component: ${binding.replace(/\.scene\.json$/, ".tsx")}\nRecipe:\n${json(recipe)}`);
      },
    },
    {
      name: "edit_take",
      description:
        'Change a take\'s edit with a JSON merge patch (only the parts to change; null removes a key), for example {"trim":{"startMs":1200}} or {"zoom":{"mode":"off"}} or {"captions":{"items":[{"atMs":1500,"durMs":2000,"text":"Open the report","source":"manual"}]}}. It is validated and saved to edit.json against the take\'s revision; returns what changed.',
      inputSchema: {
        type: "object",
        properties: {
          ...idArg,
          patch: { type: "object", description: "A JSON merge patch over the edit get_take shows." },
          note: string("Why, in a few words; returned with the result."),
          revision: string("The revision from get_take, to refuse the edit if the take changed since. Optional."),
        },
        required: ["id", "patch"],
      },
      async call(args) {
        const id = String(args.id);
        const current = unwrap(await client.get<{ take: { edit: unknown }; revision: string }>(`/v1/takes/${id}`));
        const edit = mergePatch(current.take.edit, args.patch);
        const saved = unwrap(
          await client.patch<{ take: { edit: unknown }; revision: string }>(`/v1/takes/${id}`, {
            edit,
            revision: typeof args.revision === "string" ? args.revision : current.revision,
          }),
        );
        return text(
          [
            `Saved to .clipmunk/takes/${id}/edit.json${args.note ? ` (${String(args.note)})` : ""}. Revision ${saved.revision}.`,
            formatChanges(diffJson(current.take.edit, saved.take.edit)),
          ].join("\n"),
        );
      },
    },
    {
      name: "apply_preset",
      description: "Apply a preset from clipmunk.config.json to a take's edit (or its music to a scene).",
      inputSchema: {
        type: "object",
        properties: { ...idArg, preset: string("The preset's name."), ...kindArg },
        required: ["id", "preset"],
      },
      async call(args) {
        const id = String(args.id);
        const kind = await kindOf(client, id, args.kind);
        if (kind === "sequence") throw new Error("Presets apply to takes and scenes.");
        unwrap(await client.post(`/v1/${kind}s/${id}/preset`, { name: String(args.preset) }));
        return text(`Applied ${String(args.preset)} to ${kind} ${id}.`);
      },
    },
    {
      name: "preview",
      description:
        "Render one frame of a take or scene as a PNG, exactly as export would, to check an edit. atMs is the clip's own time (after trim and pacing for takes).",
      inputSchema: {
        type: "object",
        properties: {
          ...idArg,
          atMs: { type: "number", description: "Clip time in milliseconds." },
          variant: string('For scenes: "theme:dark,locale:de,ratio:9x16".'),
          ...kindArg,
        },
        required: ["id", "atMs"],
      },
      async call(args) {
        const id = String(args.id);
        const kind = await kindOf(client, id, args.kind);
        if (kind === "sequence") throw new Error("Preview a sequence's clips one at a time.");
        const query = new URLSearchParams({ kind, id, at: String(Number(args.atMs) || 0) });
        if (typeof args.variant === "string") query.set("variant", args.variant);
        const frame = unwrap(await client.get<{ png: Buffer; atMs: number }>(`/v1/preview?${query}`));
        return {
          content: [
            { type: "image", data: frame.png.toString("base64"), mimeType: "image/png" },
            { type: "text", text: `${kind} ${id} at ${Math.round(frame.atMs)} ms.` },
          ],
        };
      },
    },
    {
      name: "export",
      description:
        'Start exporting a clip. Options: formats (["mp4","gif","poster"]), ratios (["16:9","9:16","1:1","4:5"]), variants (scene themes or locales), size ("1920x1080"), fps (30 or 60), preset. Returns a job id for get_job; files land in .clipmunk/exports.',
      inputSchema: {
        type: "object",
        properties: { ...idArg, options: { type: "object", description: "Export options, all optional." }, ...kindArg },
        required: ["id"],
      },
      async call(args) {
        const id = String(args.id);
        const kind = await kindOf(client, id, args.kind);
        const started = unwrap(
          await client.post<{ job: string }>("/v1/exports", {
            ...((args.options as object) ?? {}),
            clip: { kind, id },
          }),
        );
        return text(`Export started: job ${started.job}. Check it with get_job.`);
      },
    },
    {
      name: "get_job",
      description: "The progress or outcome of an export job.",
      inputSchema: { type: "object", properties: { id: string("The job id export returned.") }, required: ["id"] },
      async call(args) {
        const job = unwrap(
          await client.get<{
            finished: boolean;
            last?: { type: string; done?: number; total?: number; data?: unknown; issues?: Issue[] };
          }>(`/v1/jobs/${String(args.id)}`),
        );
        const last = job.last;
        if (!last) return text("Starting.");
        if (last.type === "progress")
          return text(`Running: ${last.total ? Math.round(((last.done ?? 0) / last.total) * 100) : 0}%.`);
        if (last.type === "failed")
          return {
            content: [{ type: "text", text: `Failed: ${last.issues?.map((issue) => issue.message).join(" ")}` }],
            isError: true,
          };
        return text(`Done:\n${json(last.data)}`);
      },
    },
    {
      name: "get_take_frames",
      description:
        "Stills of a take's recording itself (the raw screen, before trim, zoom or frame) as PNGs, to see the layout, data and states a scene should reproduce. times are on the recording's clock, like get_take's summary; by default, each click.",
      inputSchema: {
        type: "object",
        properties: {
          ...idArg,
          times: { type: "array", items: { type: "number" }, description: "Recording times in ms, up to 8." },
        },
        required: ["id"],
      },
      async call(args) {
        const id = String(args.id);
        const take = await readTake(client, id);
        const { trim } = take.take.edit as { trim: { startMs: number; endMs: number } };
        const times =
          Array.isArray(args.times) && args.times.length ? args.times.map(Number) : keyMoments(take.events, trim);
        const content: ToolResult["content"] = [];
        for (const atMs of times.slice(0, 8)) {
          const frame = unwrap(
            await client.get<{ png: Buffer; atMs: number }>(`/v1/takes/${id}/frame?at=${Math.round(atMs)}`),
          );
          content.push(
            {
              type: "text",
              text: `take ${id} at ${(frame.atMs / 1000).toFixed(2)} s (scene time ${Math.max(0, frame.atMs - trim.startMs)} ms):`,
            },
            { type: "image", data: frame.png.toString("base64"), mimeType: "image/png" },
          );
        }
        return { content };
      },
    },
    {
      name: "check_scene",
      description:
        "Check a scene: the issues its files have (fix all of them), and frames rendered as export would at the given scene times, to compare with get_take_frames. The host's dev server must be running for frames.",
      inputSchema: {
        type: "object",
        properties: {
          ...idArg,
          times: {
            type: "array",
            items: { type: "number" },
            description: "Scene times in ms, up to 8. Default: start, two thirds and end.",
          },
          variant: string('Optional: "theme:dark,ratio:9x16".'),
        },
        required: ["id"],
      },
      async call(args) {
        const id = String(args.id);
        const catalog = unwrap(
          await client.get<{ scenes: { id: string; definition: { motion?: never } }[]; issues: Issue[] }>(
            "/v1/scenes?detail=1",
          ),
        );
        const issues = catalog.issues.filter((issue) => JSON.stringify(issue).includes(id));
        const scene = catalog.scenes.find((candidate) => candidate.id === id);
        const lines = issues.length
          ? ["Issues:", ...issues.map((issue) => `  ${issue.path ? `${issue.path}: ` : ""}${issue.message}`)]
          : ["No issues."];
        if (!scene)
          return {
            content: [{ type: "text", text: [`No valid scene named "${id}".`, ...lines].join("\n") }],
            isError: true,
          };
        const durationMs = scene.definition.motion ? motionDuration(scene.definition.motion) : 0;
        const times =
          Array.isArray(args.times) && args.times.length
            ? args.times.map(Number)
            : [...new Set([0, Math.round((durationMs * 2) / 3), Math.max(0, durationMs - 1)])];
        const content: ToolResult["content"] = [
          { type: "text", text: `scene ${id}, ${(durationMs / 1000).toFixed(2)} s. ${lines.join("\n")}` },
        ];
        for (const atMs of times.slice(0, 8)) {
          const query = new URLSearchParams({ kind: "scene", id, at: String(Math.round(atMs)) });
          if (typeof args.variant === "string") query.set("variant", args.variant);
          const reply = await client.get<{ png: Buffer; atMs: number }>(`/v1/preview?${query}`);
          if (!reply.ok) {
            content.push({
              type: "text",
              text: `No frame at ${Math.round(atMs)} ms: ${reply.issues.map((issue) => issue.message).join(" ")}`,
            });
            break;
          }
          content.push(
            { type: "text", text: `at ${Math.round(reply.data.atMs)} ms:` },
            { type: "image", data: reply.data.png.toString("base64"), mimeType: "image/png" },
          );
        }
        return content.length === 1 && issues.length ? { content, isError: true } : { content };
      },
    },
    {
      name: "wait_for_chat",
      description:
        "Wait for the developer's next message in the Clipmunk Studio chat. Blocks until one arrives or timeoutMs passes (then call it again). The message comes with what they pointed at: a clip, a moment, an element. Answer with reply_chat. When asked to watch the Clipmunk chat, keep calling this in a loop.",
      inputSchema: {
        type: "object",
        properties: { timeoutMs: { type: "number", description: "How long to wait, up to 240000. Default 45000." } },
      },
      async call(args, session) {
        const timeoutMs = Math.min(Math.max(Number(args.timeoutMs) || 45_000, 1000), 240_000);
        const query = new URLSearchParams({ timeoutMs: String(timeoutMs), agent: session.client ?? "" });
        const { message } = unwrap(await client.get<{ message: ChatMessage | null }>(`/v1/chat/next?${query}`));
        if (!message) return text("No message yet. Call wait_for_chat again to keep listening.");
        return text(formatChatMessage(message));
      },
    },
    {
      name: "reply_chat",
      description:
        'Answer the developer in the Studio chat. To suggest a change to a take, add a proposal: {"takeId","patch","note"} where patch is a JSON merge patch over the take\'s edit, as for edit_take. A proposal is not applied: the developer sees it as a diff with Keep and Undo. followUps are up to four short next steps they can send with one click.',
      inputSchema: {
        type: "object",
        properties: {
          text: string("Your answer, in plain sentences."),
          proposal: {
            type: "object",
            description: "An edit to propose, not applied until the developer keeps it.",
            properties: {
              takeId: string("The take to change."),
              patch: { type: "object", description: "A JSON merge patch over the take's edit." },
              note: string("What it does, in a few words."),
            },
            required: ["takeId", "patch"],
          },
          followUps: { type: "array", items: { type: "string" }, description: "Suggested next messages." },
        },
        required: ["text"],
      },
      async call(args) {
        const sent = unwrap(
          await client.post<{ id: string; proposal?: { takeId: string } }>("/v1/chat/reply", {
            text: args.text,
            ...(args.proposal ? { proposal: args.proposal } : {}),
            ...(args.followUps ? { followUps: args.followUps } : {}),
          }),
        );
        return text(
          sent.proposal
            ? `Sent, with a proposal for take ${sent.proposal.takeId} the developer can keep or undo. Call wait_for_chat for their answer.`
            : "Sent. Call wait_for_chat for their answer.",
        );
      },
    },
  ];
}

export const MCP_INSTRUCTIONS =
  "Clipmunk makes product videos from this app: takes (screen recordings with an edit) and scenes (the app's components animated in 3D). list_clips first; get_take shows what happened in a take and its edit; change it with edit_take (a JSON merge patch) and check the result with preview before you export. To make a scene from a take, follow the guide's 'From a take' section (npx clipmunk guide), with get_take_frames and check_scene. The daemon must be running (npx clipmunk dev). When asked to watch the Clipmunk chat, loop on wait_for_chat and answer each message with reply_chat; propose edits there rather than applying them.";
