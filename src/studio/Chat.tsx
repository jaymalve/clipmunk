import { useCallback, useEffect, useRef, useState } from "react";
import { diffJson, formatChanges, mergePatch } from "../core";
import type { DaemonClient } from "../recorder";
import { onStudioEvent } from "./events";

/** The chat with the developer's coding agent. Messages go to the daemon, which keeps them in
 * `.clipmunk/chat/`; the agent picks them up with `wait_for_chat` and answers with `reply_chat`.
 * Each message carries what the developer pointed at (the clip, a moment, an element) as chips.
 * An agent's proposed edit is a diff here and changes nothing until Keep; Undo steps back
 * through the take's history.
 */
export type ChatContext =
  | { kind: "clip"; clip: { kind: string; id: string } }
  | { kind: "time"; ms: number }
  | { kind: "element"; sel: string; name?: string; role?: string }
  | { kind: "component"; file: string };
export type ChatProposal = { takeId: string; patch: unknown; note?: string; status: "proposed" | "kept" | "undone" };
type ChatMessage = {
  id: string;
  from: "developer" | "agent";
  text: string;
  context?: ChatContext[];
  proposal?: ChatProposal;
  followUps?: string[];
  delivered?: boolean;
};
type ChatState = { messages: ChatMessage[]; agent?: { name: string; waiting: boolean } };

export const WATCH_PROMPT = "Watch the Clipmunk chat";

const chipLabel = (chip: ChatContext) =>
  chip.kind === "clip"
    ? `${chip.clip.kind} ${chip.clip.id}`
    : chip.kind === "time"
      ? `at ${(chip.ms / 1000).toFixed(2)}s`
      : chip.kind === "element"
        ? (chip.name ?? chip.sel)
        : chip.file;

export function ChatPanel(props: {
  client: DaemonClient;
  /** The clip on screen; every message is about it. */
  clip?: { kind: string; id: string };
  /** Chips the page added (a moment, a picked element), sent with the next message. */
  chips: ChatContext[];
  onChips: (chips: ChatContext[]) => void;
  /** The current playhead, offered as a chip. */
  moment?: () => number;
  /** Start picking an element in the preview to talk about. */
  onPickElement?: () => void;
  /** The take on screen, to show a proposal for it as a diff against its edit. */
  edit?: { takeId: string; value: unknown };
  /** Show a proposal in the preview (or stop, with undefined). */
  onPreview?: (preview: { message: string; proposal: ChatProposal } | undefined) => void;
  /** The message whose proposal is being previewed. */
  previewing?: string;
  /** Before Keep: save what the page has not saved yet. */
  beforeKeep?: () => Promise<void>;
  /** After Keep or Undo changed a take on disk. */
  onApplied?: (takeId: string) => void;
  onClose: () => void;
}) {
  const { client } = props;
  const [state, setState] = useState<ChatState>({ messages: [] });
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string>();
  const list = useRef<HTMLOListElement>(null);
  const load = useCallback(
    () => void client.get<ChatState>("/v1/chat").then((result) => result.ok && setState(result.data)),
    [client],
  );
  useEffect(() => {
    load();
    return onStudioEvent(client, (event) => {
      if (event.type === "chat") load();
    });
  }, [client, load]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the messages change
  useEffect(() => {
    list.current?.lastElementChild?.scrollIntoView({ block: "end" });
  }, [state.messages.length]);

  const send = async (text: string) => {
    if (!text.trim()) return;
    const context: ChatContext[] = [
      ...(props.clip ? [{ kind: "clip" as const, clip: props.clip }] : []),
      ...props.chips,
    ];
    const result = await client.post("/v1/chat", { text, context });
    if (!result.ok) return setProblem(result.issues[0]?.message);
    setProblem(undefined);
    setDraft("");
    props.onChips([]);
  };
  const act = async (message: ChatMessage, action: "keep" | "undo") => {
    if (action === "keep") await props.beforeKeep?.();
    if (props.previewing) props.onPreview?.(undefined);
    const result = await client.post(`/v1/chat/${message.id}/${action}`, {});
    if (!result.ok) return setProblem(result.issues[0]?.message);
    setProblem(undefined);
    props.onApplied?.(message.proposal!.takeId);
  };
  const last = state.messages.at(-1);

  return (
    <section className="chat" role="dialog" aria-label="Chat with your agent">
      <header>
        <b>Chat</b>
        <span className="agent" role="status">
          {state.agent
            ? `${state.agent.name} ${state.agent.waiting ? "is listening" : "is working"}`
            : "No agent is listening"}
        </span>
        <button type="button" aria-label="Close chat" onClick={props.onClose}>
          ×
        </button>
      </header>
      {!state.agent && (
        <p className="hint connect">
          Tell your coding agent: <code>{WATCH_PROMPT}</code>{" "}
          <button type="button" onClick={() => void navigator.clipboard?.writeText(WATCH_PROMPT)}>
            Copy
          </button>
          <br />
          It needs Clipmunk's MCP server (npx clipmunk init prints how to add it).
        </p>
      )}
      <ol ref={list} className="messages">
        {state.messages.map((message) => (
          <li key={message.id} className={message.from} data-chat-message={message.id}>
            <p>{message.text}</p>
            {!!message.context?.length && (
              <div className="chips">
                {message.context.map((chip, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: chips of one sent message never move
                  <span key={index} className="chip">
                    {chipLabel(chip)}
                  </span>
                ))}
              </div>
            )}
            {message.from === "developer" && !message.delivered && <span className="hint">Waiting for the agent</span>}
            {message.proposal && (
              <Proposal
                proposal={message.proposal}
                edit={props.edit}
                previewing={props.previewing === message.id}
                onPreview={
                  props.onPreview && props.edit?.takeId === message.proposal.takeId
                    ? (on) => props.onPreview?.(on ? { message: message.id, proposal: message.proposal! } : undefined)
                    : undefined
                }
                onKeep={() => void act(message, "keep")}
                onUndo={() => void act(message, "undo")}
              />
            )}
          </li>
        ))}
      </ol>
      {last?.from === "agent" && !!last.followUps?.length && (
        <fieldset className="follow-ups" aria-label="Suggested follow-ups">
          {last.followUps.map((followUp) => (
            <button key={followUp} type="button" onClick={() => void send(followUp)}>
              {followUp}
            </button>
          ))}
        </fieldset>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void send(draft);
        }}
      >
        <div className="chips">
          {props.clip && <span className="chip fixed">{chipLabel({ kind: "clip", clip: props.clip })}</span>}
          {props.chips.map((chip, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a chip is removed by its place in the list
            <span key={index} className="chip">
              {chipLabel(chip)}
              <button
                type="button"
                aria-label={`Remove ${chipLabel(chip)}`}
                onClick={() => props.onChips(props.chips.filter((_, other) => other !== index))}
              >
                ×
              </button>
            </span>
          ))}
          {props.moment && (
            <button
              type="button"
              className="add"
              onClick={() => props.onChips([...props.chips, { kind: "time", ms: Math.round(props.moment!()) }])}
            >
              + This moment
            </button>
          )}
          {props.onPickElement && (
            <button type="button" className="add" onClick={props.onPickElement}>
              + An element
            </button>
          )}
        </div>
        <textarea
          aria-label="Message to your agent"
          value={draft}
          rows={2}
          placeholder="Tighten the start and zoom on the report button"
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send(draft);
            }
          }}
        />
        <div className="row">
          {problem && <span className="bad">{problem}</span>}
          <span className="spacer" />
          <button type="submit" disabled={!draft.trim()}>
            Send
          </button>
        </div>
      </form>
    </section>
  );
}

function Proposal(props: {
  proposal: ChatProposal;
  edit?: { takeId: string; value: unknown };
  previewing: boolean;
  onPreview?: (on: boolean) => void;
  onKeep: () => void;
  onUndo: () => void;
}) {
  const { proposal } = props;
  // Against the edit on screen when it is the same take; otherwise the patch itself.
  const changes =
    props.edit?.takeId === proposal.takeId && proposal.status === "proposed"
      ? formatChanges(diffJson(props.edit.value, mergePatch(props.edit.value, proposal.patch)))
      : JSON.stringify(proposal.patch, null, 2);
  return (
    <div className="proposal" data-status={proposal.status}>
      <div className="hint">
        Proposed edit to take {proposal.takeId}
        {proposal.note ? `: ${proposal.note}` : ""}
      </div>
      <pre data-proposal-changes>{changes}</pre>
      <div className="row">
        {proposal.status === "proposed" && (
          <>
            {props.onPreview && (
              <button type="button" aria-pressed={props.previewing} onClick={() => props.onPreview!(!props.previewing)}>
                Preview
              </button>
            )}
            <button type="button" className="apply" onClick={props.onKeep}>
              Keep
            </button>
          </>
        )}
        {proposal.status === "kept" && (
          <>
            <span className="hint">Kept</span>
            <button type="button" onClick={props.onUndo}>
              Undo
            </button>
          </>
        )}
        {proposal.status === "undone" && (
          <>
            <span className="hint">Undone</span>
            <button type="button" onClick={props.onKeep}>
              Keep again
            </button>
          </>
        )}
      </div>
    </div>
  );
}
