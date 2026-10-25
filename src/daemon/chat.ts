import { randomBytes } from "node:crypto";
import { fail, mergePatch, ok, type Result, TakeEditSchema } from "../core";
import { loadTake, readText, saveTakeEditWithHistory, stepTakeHistory, writeText } from "../project";
import type { Context } from "./takes";

/** Chat between the developer in the Studio and their coding agent. MCP cannot push into an agent's
 * session, so the agent waits on a blocking call (`wait_for_chat`, a long poll here) for the next
 * message, and answers with text, follow-up suggestions and, when it proposes an edit, a merge patch
 * that is not applied until the developer keeps it. The conversation is a file in `.clipmunk/chat/`
 * (ignored by git), so a reload, a broken host or a daemon restart loses nothing.
 */
export const CHAT_FILE = ".clipmunk/chat/messages.json";
export type ChatContext =
  | { kind: "clip"; clip: { kind: string; id: string } }
  | { kind: "time"; ms: number }
  | { kind: "element"; sel: string; name?: string; role?: string }
  | { kind: "component"; file: string };
export type Proposal = {
  takeId: string;
  patch: unknown;
  note?: string;
  status: "proposed" | "kept" | "undone";
};
export type ChatMessage = {
  id: string;
  at: string;
  from: "developer" | "agent";
  text: string;
  context?: ChatContext[];
  proposal?: Proposal;
  followUps?: string[];
  /** Developer messages: whether an agent has received it. */
  delivered?: boolean;
};
type Waiter = (message: ChatMessage | undefined) => void;

export function createChat(context: Context, onChange: () => void) {
  const waiters = new Set<Waiter>();
  let agent: { name: string; seenAt: number } | undefined;
  const read = async (): Promise<ChatMessage[]> => {
    try {
      const messages = JSON.parse((await readText(context.root, CHAT_FILE)) ?? "[]");
      return Array.isArray(messages) ? messages : [];
    } catch {
      return [];
    }
  };
  // One write at a time, so concurrent posts never lose each other.
  let queue: Promise<unknown> = Promise.resolve();
  const update = <T>(change: (messages: ChatMessage[]) => T | Promise<T>): Promise<T> => {
    const run = queue.then(async () => {
      const messages = await read();
      const result = await change(messages);
      await writeText(context.root, CHAT_FILE, `${JSON.stringify(messages, null, 2)}\n`);
      return result;
    });
    queue = run.catch(() => {});
    return run;
  };
  const newId = () => `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;

  /** Hand the oldest undelivered developer message to an agent, marking it delivered. */
  const deliver = () =>
    update((messages) => {
      const next = messages.find((message) => message.from === "developer" && !message.delivered);
      if (next) next.delivered = true;
      return next;
    });

  return {
    async list() {
      const listening = agent && (waiters.size > 0 || Date.now() - agent.seenAt < 60_000);
      return {
        messages: await read(),
        agent: listening ? { name: agent!.name, waiting: waiters.size > 0 } : undefined,
      };
    },
    async post(body: unknown): Promise<Result<ChatMessage>> {
      const input = (body && typeof body === "object" ? body : {}) as { text?: unknown; context?: unknown };
      const text = typeof input.text === "string" ? input.text.trim() : "";
      if (!text) return fail([{ code: "invalid-chat", message: "A message needs some text." }]);
      const message: ChatMessage = {
        id: newId(),
        at: new Date().toISOString(),
        from: "developer",
        text: text.slice(0, 4000),
        ...(Array.isArray(input.context) ? { context: input.context.slice(0, 12) as ChatContext[] } : {}),
      };
      await update((messages) => void messages.push(message));
      onChange();
      // A waiting agent gets it at once.
      const waiter = waiters.values().next().value;
      if (waiter) {
        waiters.delete(waiter);
        waiter(await deliver());
      }
      return ok(message);
    },
    /** Long poll: the next undelivered developer message, or nothing after `timeoutMs`. */
    async next(timeoutMs: number, name: string, signal?: AbortSignal): Promise<ChatMessage | undefined> {
      agent = { name: name.slice(0, 60) || "Your agent", seenAt: Date.now() };
      const ready = await deliver();
      if (ready) return ready;
      onChange();
      return new Promise((resolve) => {
        const waiter: Waiter = (message) => {
          clearTimeout(timer);
          if (agent) agent.seenAt = Date.now();
          onChange();
          resolve(message);
        };
        const stop = () => {
          clearTimeout(timer);
          if (!waiters.delete(waiter)) return;
          if (agent) agent.seenAt = Date.now();
          onChange();
          resolve(undefined);
        };
        const timer = setTimeout(stop, Math.max(1000, Math.min(timeoutMs, 10 * 60_000)));
        // An agent that gave up (its call was cancelled) must not swallow the next message.
        signal?.addEventListener("abort", stop, { once: true });
        waiters.add(waiter);
      });
    },
    async reply(body: unknown): Promise<Result<ChatMessage>> {
      const input = (body && typeof body === "object" ? body : {}) as {
        text?: unknown;
        proposal?: unknown;
        followUps?: unknown;
      };
      const text = typeof input.text === "string" ? input.text.trim() : "";
      if (!text) return fail([{ code: "invalid-chat", message: "A reply needs some text." }]);
      let proposal: Proposal | undefined;
      if (input.proposal && typeof input.proposal === "object") {
        const { takeId, patch, note } = input.proposal as { takeId?: unknown; patch?: unknown; note?: unknown };
        if (typeof takeId !== "string" || !patch || typeof patch !== "object")
          return fail([{ code: "invalid-chat", message: "A proposal needs a takeId and a patch object." }]);
        // Check it would apply now, so the developer is never offered an edit that cannot be kept.
        const loaded = await loadTake(context.root, takeId);
        if (!loaded.ok) return loaded;
        const checked = TakeEditSchema.safeParse(mergePatch(loaded.data.take.edit, patch));
        if (!checked.success)
          return fail([
            {
              code: "invalid-proposal",
              message: `The proposed patch does not give a valid edit: ${checked.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
            },
          ]);
        proposal = { takeId, patch, ...(typeof note === "string" ? { note } : {}), status: "proposed" };
      }
      const followUps = Array.isArray(input.followUps)
        ? input.followUps.filter((item): item is string => typeof item === "string").slice(0, 4)
        : undefined;
      const message: ChatMessage = {
        id: newId(),
        at: new Date().toISOString(),
        from: "agent",
        text: text.slice(0, 8000),
        ...(proposal ? { proposal } : {}),
        ...(followUps?.length ? { followUps } : {}),
      };
      await update((messages) => void messages.push(message));
      onChange();
      return ok(message);
    },
    /** Keep a proposal: apply its patch to the take now, through the history so it can be undone. */
    async keep(id: string): Promise<Result<{ message: ChatMessage; revision: string }>> {
      return update(async (messages) => {
        const message = messages.find((candidate) => candidate.id === id);
        if (!message?.proposal) return fail([{ code: "unknown-proposal", message: "No proposal with that id." }]);
        if (message.proposal.status === "kept")
          return fail([{ code: "already-kept", message: "This proposal was already kept." }]);
        const loaded = await loadTake(context.root, message.proposal.takeId);
        if (!loaded.ok) return loaded;
        const saved = await saveTakeEditWithHistory(context.root, message.proposal.takeId, {
          edit: mergePatch(loaded.data.take.edit, message.proposal.patch),
          revision: loaded.data.revision,
        });
        if (!saved.ok) return saved;
        message.proposal.status = "kept";
        return ok({ message, revision: saved.data.revision });
      }).finally(onChange);
    },
    /** Undo a kept proposal: one step back in the take's history. */
    async undo(id: string): Promise<Result<{ message: ChatMessage; revision: string }>> {
      return update(async (messages) => {
        const message = messages.find((candidate) => candidate.id === id);
        if (message?.proposal?.status !== "kept")
          return fail([{ code: "not-kept", message: "Only a kept proposal can be undone." }]);
        const loaded = await loadTake(context.root, message.proposal.takeId);
        if (!loaded.ok) return loaded;
        const stepped = await stepTakeHistory(context.root, message.proposal.takeId, -1, loaded.data.revision);
        if (!stepped.ok) return stepped;
        message.proposal.status = "undone";
        return ok({ message, revision: stepped.data.revision });
      }).finally(onChange);
    },
    /** Put a message back in line, when the agent it went to was gone before it got it. */
    async undeliver(id: string) {
      await update((messages) => {
        const message = messages.find((candidate) => candidate.id === id);
        if (message) message.delivered = false;
      });
    },
    close() {
      for (const waiter of waiters) waiter(undefined);
      waiters.clear();
    },
  };
}
export type Chat = ReturnType<typeof createChat>;
