import { type PointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { layoutTake } from "../compositor";
import {
  applyPreset,
  buildTimeMap,
  type Issue,
  mergePatch,
  type Preset,
  parseEvents,
  RATIOS,
  type Ratio,
  resolveCaptions,
  resolveZoomTracks,
  type Span,
  type Take,
  type TakeEdit,
  TakeEditSchema,
  type TakeEvent,
  TakeEventSchema,
  takeMoments,
  withRatio,
  zoomAt,
  zoomSegments,
} from "../core";
import { createClock } from "../react";
import type { DaemonClient } from "../recorder";
import { SaveStatus, useAutosave } from "./autosave";
import { type ChatContext, ChatPanel, type ChatProposal, MAKE_SCENE_PROMPT } from "./Chat";
import { Chrome } from "./Chrome";
import { type DaemonState, ExportPanel } from "./daemon";
import { CaptionInspector, ZoomInspector } from "./Inspector";
import { IssueList } from "./IssueList";
import { useMusicPreview } from "./music";
import { PresetBar } from "./PresetBar";
import { Rail } from "./Rail";
import { useClipSession } from "./session";
import { RedactionControls, TakeControls } from "./TakeControls";
import { Time } from "./Timeline";
import { type Selection, Tracks } from "./Tracks";
import { usePreview, useTakeBridge, useTakeRenderer, useVoice } from "./take-hooks";

/** The take editor: a live preview of the composited take, a timeline, and the controls
 * for everything in `take.edit`. Edits are saved to edit.json through the daemon, so the
 * file stays the source of truth and a coding agent can edit the same take.
 */

export function TakeEditor({ id, daemon, backHref }: { id: string; daemon: DaemonState; backHref: string }) {
  const [loaded, setLoaded] = useState<{ take: Take; revision: string; events: TakeEvent[]; speech: Span[] }>();
  const [issues, setIssues] = useState<Issue[]>();
  const client = daemon?.client;
  useEffect(() => {
    if (!client) return;
    let current = true;
    void (async () => {
      const result = await client.get<{ take: Take; revision: string; speech?: Span[] }>(`/v1/takes/${id}`);
      if (!current) return;
      if (!result.ok) return setIssues(result.issues);
      const log = await fetch(client.url(`/v1/takes/${id}/files/${result.data.take.source.events.file}`)).then(
        (response) => (response.ok ? response.text() : ""),
        () => "",
      );
      if (current)
        setLoaded({ ...result.data, speech: result.data.speech ?? [], events: parseEvents(log, TakeEventSchema) });
    })();
    return () => {
      current = false;
    };
  }, [client, id]);

  if (loaded && client) return <Editor key={id} {...loaded} client={client} daemon={daemon} backHref={backHref} />;
  return (
    <Chrome style={{ position: "fixed", inset: 0, overflow: "auto", background: "#000" }}>
      <div className="take">
        <header>
          <a href={backHref}>← Library</a>
          <h1>{id}</h1>
        </header>
        {daemon?.problem && <p className="note">The daemon is not connected. {daemon.problem.message}</p>}
        {issues && <IssueList issues={issues} title="This take cannot be opened." />}
      </div>
    </Chrome>
  );
}

function Editor(props: {
  take: Take;
  revision: string;
  events: TakeEvent[];
  speech: Span[];
  client: DaemonClient;
  daemon: DaemonState;
  backHref: string;
}) {
  const { client, events, speech } = props;
  const [take, setTake] = useState(props.take);
  const [exporting, setExporting] = useState(false);
  // The canvas lives inside the studio's shadow root, which mounts a render later than this component.
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const [clock] = useState(() => createClock());
  const { edit, source } = take;
  // Derived here, not read back from the renderer, which only learns of an edit after this render.
  const timeMap = useMemo(() => buildTimeMap(edit, events, speech), [edit, events, speech]);
  const { durationMs } = timeMap;
  const file = useCallback((name: string) => client.url(`/v1/takes/${take.id}/files/${name}`), [client, take.id]);

  const { renderer, failure } = useTakeRenderer(canvas, props.take, events, file, speech);
  const session = useClipSession(clock, durationMs, !!renderer);
  // "Preview as" shows the take reframed to another shape without changing its edit.
  const [previewRatio, setPreviewRatio] = useState<Ratio>();
  // A preset chosen in the bar is previewed at once and becomes the edit only when applied.
  const [previewPreset, setPreviewPreset] = useState<{ name: string; preset: Preset }>();
  // So is an edit the agent proposed in the chat, until it is kept.
  const [chatOpen, setChatOpen] = useState(false);
  const [chips, setChips] = useState<ChatContext[]>([]);
  const [previewProposal, setPreviewProposal] = useState<{ message: string; proposal: ChatProposal }>();
  const previewTake = useMemo(() => {
    let edit = take.edit;
    if (previewProposal) {
      const proposed = TakeEditSchema.safeParse(mergePatch(edit, previewProposal.proposal.patch));
      if (proposed.success) edit = proposed.data;
    }
    if (previewPreset) {
      const applied = applyPreset(edit, previewPreset.preset);
      if (applied.ok) edit = applied.data;
    }
    if (previewRatio) edit = withRatio(edit, previewRatio);
    return edit === take.edit ? take : { ...take, edit };
  }, [take, previewRatio, previewPreset, previewProposal]);
  usePreview(renderer, previewTake, clock);
  useVoice(audio, take, timeMap, clock, session.playing);
  useTakeBridge(renderer, take, durationMs, clock, session.seek);
  const moments = useMemo(() => takeMoments(timeMap, events), [timeMap, events]);
  useMusicPreview({
    music: edit.music,
    clip: { key: `take:${take.id}`, durationMs, momentsMs: moments },
    clock,
    playing: session.playing,
  });
  const segments = useMemo(
    () => zoomSegments(resolveZoomTracks({ zoom: edit.zoom }, events, source)),
    [edit.zoom, events, source],
  );
  const captions = useMemo(
    () =>
      resolveCaptions(edit, events, { keepEmpty: true }).filter(
        (caption) => caption.atMs + caption.durMs > edit.trim.startMs && caption.atMs < edit.trim.endMs,
      ),
    [edit, events],
  );

  // The revision detects a take that was edited elsewhere since it was read.
  const revision = useRef(props.revision);
  const [history, setHistory] = useState<{ canUndo: boolean; canRedo: boolean }>({ canUndo: false, canRedo: false });
  const refreshHistory = useCallback(
    () =>
      void client
        .get<{ canUndo: boolean; canRedo: boolean }>(`/v1/takes/${take.id}/history`)
        .then((result) => result.ok && setHistory(result.data)),
    [client, take.id],
  );
  useEffect(refreshHistory, [refreshHistory]);
  const save = useAutosave(take, async (next) => {
    const body = { edit: next.edit, title: next.title, revision: revision.current };
    const result = await client.patch<{ take: Take; revision: string }>(`/v1/takes/${next.id}`, body);
    if (!result.ok) return result.issues[0]!.message;
    revision.current = result.data.revision;
    refreshHistory();
    return undefined;
  });
  /** Undo or redo through the daemon's history; the take it returns is already on disk. */
  const step = async (direction: "undo" | "redo") => {
    await save.flush();
    const result = await client.post<{ take: Take; revision: string; canUndo: boolean; canRedo: boolean }>(
      `/v1/takes/${take.id}/${direction}`,
      { revision: revision.current },
    );
    if (!result.ok) return;
    revision.current = result.data.revision;
    save.adopt(result.data.take);
    setTake(result.data.take);
    setHistory({ canUndo: result.data.canUndo, canRedo: result.data.canRedo });
  };
  /** Read the take back from disk after something else saved it (a kept proposal). */
  const reload = async () => {
    const result = await client.get<{ take: Take; revision: string }>(`/v1/takes/${take.id}`);
    if (!result.ok) return;
    revision.current = result.data.revision;
    save.adopt(result.data.take);
    setTake(result.data.take);
    refreshHistory();
  };
  const stepRef = useRef(step);
  stepRef.current = step;
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "z") return;
      if (event.target instanceof HTMLInputElement && event.target.type === "text") return;
      event.preventDefault();
      void stepRef.current(event.shiftKey ? "redo" : "undo");
    };
    addEventListener("keydown", keys);
    return () => removeEventListener("keydown", keys);
  }, []);

  const change = (update: (edit: TakeEdit) => TakeEdit) =>
    setTake((current) => ({ ...current, edit: update(current.edit) }));
  const setTrim = (startMs: number, endMs: number) => {
    const start = Math.max(0, Math.min(startMs, source.durationMs - 100));
    const end = Math.max(start + 100, Math.min(endMs, source.durationMs));
    change((current) => ({ ...current, trim: { startMs: Math.round(start), endMs: Math.round(end) } }));
  };
  /** The trim buttons start playback over from the new start; dragging a handle leaves the playhead. */
  const trimFromButton = (startMs: number, endMs: number) => {
    session.seek(0);
    setTrim(startMs, endMs);
  };
  const remove = () =>
    confirm("Delete this take and its media?") &&
    void client.remove(`/v1/takes/${take.id}`).then(() => location.assign(props.backHref));
  const untrimmed = edit.trim.startMs === 0 && edit.trim.endMs === source.durationMs;

  const [selection, setSelection] = useState<Selection>();
  const [drawing, setDrawing] = useState(false);
  const [swatches, setSwatches] = useState<string[]>(DEFAULT_SWATCHES);
  useEffect(() => {
    void client.get<{ config: { brand?: { backdrop?: string } } }>("/v1/config").then((result) => {
      const brand = result.ok ? result.data.config.brand?.backdrop : undefined;
      setSwatches(brand ? [brand, ...DEFAULT_SWATCHES.filter((colour) => colour !== brand)] : DEFAULT_SWATCHES);
    });
  }, [client]);
  const shownCaptions = useMemo(
    () => captions.filter((caption) => caption.text || selection?.kind === "caption"),
    [captions, selection],
  );
  const zoomSpans = useMemo(() => segments.map(({ startMs, endMs }) => ({ startMs, endMs })), [segments]);

  // Drawing a box to hide: drag over the preview; the box is in the recording's own pixels.
  const drag = useRef<{ x: number; y: number } | undefined>(undefined);
  const toSource = (clientX: number, clientY: number) => {
    const area = canvas!.getBoundingClientRect();
    const x = ((clientX - area.left) / area.width) * canvas!.width,
      y = ((clientY - area.top) / area.height) * canvas!.height;
    const layout = layoutTake(canvas!.width, canvas!.height, take);
    const view = zoomAt(resolveZoomTracks(edit, events, source), timeMap.toTake(clock.get()), source);
    const centreX = layout.box.x + layout.box.width / 2,
      centreY = layout.box.y + layout.box.height / 2;
    return {
      x: view.x + (x - centreX) / (layout.scale * view.scale),
      y: view.y + (y - centreY) / (layout.scale * view.scale),
    };
  };
  const drawStart = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!drawing) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = toSource(event.clientX, event.clientY);
  };
  const drawEnd = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!drawing || !drag.current) return;
    const from = drag.current,
      to = toSource(event.clientX, event.clientY);
    drag.current = undefined;
    setDrawing(false);
    const rect: [number, number, number, number] = [
      Math.round(Math.max(0, Math.min(from.x, to.x))),
      Math.round(Math.max(0, Math.min(from.y, to.y))),
      Math.round(Math.abs(to.x - from.x)),
      Math.round(Math.abs(to.y - from.y)),
    ];
    if (rect[2] < 2 || rect[3] < 2) return;
    const at = Math.round(timeMap.toTake(clock.get()));
    change((current) => ({
      ...current,
      redact: [...current.redact, { rect, fromMs: at, toMs: Math.min(source.durationMs, at + 3000), mode: "block" }],
    }));
  };

  return (
    <Chrome style={{ position: "fixed", inset: 0, background: "#000" }}>
      <div className="editor">
        <Rail client={client} current={{ kind: "take", id: take.id }} />
        <header>
          <input
            className="title"
            aria-label="Take title"
            value={take.title}
            onChange={(event) => {
              const title = event.currentTarget.value;
              setTake((current) => ({ ...current, title: title || current.title }));
            }}
          />
          <button type="button" onClick={() => void step("undo")} disabled={!history.canUndo} title="Undo (Ctrl+Z)">
            Undo
          </button>
          <button
            type="button"
            onClick={() => void step("redo")}
            disabled={!history.canRedo}
            title="Redo (Ctrl+Shift+Z)"
          >
            Redo
          </button>
          <label className="preview-as">
            Preview as
            <select
              aria-label="Preview as"
              value={previewRatio ?? ""}
              onChange={(event) => setPreviewRatio((event.currentTarget.value || undefined) as Ratio | undefined)}
            >
              <option value="">Its own frame</option>
              {RATIOS.map((ratio) => (
                <option key={ratio} value={ratio}>
                  {ratio}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={() => setExporting((value) => !value)} disabled={!renderer}>
            Export
          </button>
          <button type="button" aria-pressed={chatOpen} onClick={() => setChatOpen((value) => !value)}>
            Chat
          </button>
          <button
            type="button"
            onClick={() =>
              void client
                .post("/v1/chat", {
                  text: MAKE_SCENE_PROMPT,
                  context: [{ kind: "clip", clip: { kind: "take", id: take.id } }],
                })
                .then(() => setChatOpen(true))
            }
          >
            Make a scene from this take
          </button>
          <button type="button" onClick={remove}>
            Delete
          </button>
        </header>
        {exporting && (
          <ExportPanel clip={{ takeId: take.id }} daemon={props.daemon} before={save.flush} frame={edit.canvas} />
        )}
        <PresetBar
          client={client}
          takeId={take.id}
          previewing={previewPreset?.name}
          onPreview={(preset, name) => setPreviewPreset(preset && name ? { preset, name } : undefined)}
          onApply={() => {
            const chosen = previewPreset;
            setPreviewPreset(undefined);
            if (chosen)
              change((current) => {
                const applied = applyPreset(current, chosen.preset);
                return applied.ok ? applied.data : current;
              });
          }}
          beforeSave={save.flush}
        />
        <div className="stage">
          <canvas
            ref={setCanvas}
            data-clipmunk-take={take.id}
            className={drawing ? "drawing" : undefined}
            width={previewTake.edit.canvas.width}
            height={previewTake.edit.canvas.height}
            onPointerDown={drawStart}
            onPointerUp={drawEnd}
          />
          {failure && (
            <div className="issues" role="alert">
              <strong>This take cannot be previewed.</strong> {failure}
            </div>
          )}
          {!renderer && !failure && <p className="note">Loading the recording…</p>}
        </div>
        <aside>
          {selection?.kind === "zoom" ? (
            <ZoomInspector
              take={take}
              events={events}
              index={selection.index}
              change={change}
              onDone={() => setSelection(undefined)}
            />
          ) : selection?.kind === "caption" ? (
            <CaptionInspector
              caption={captions.find((caption) => caption.atMs === selection.atMs)}
              change={change}
              onDone={() => setSelection(undefined)}
            />
          ) : selection?.kind === "redact" ? (
            <>
              <RedactionControls
                edit={edit}
                change={change}
                drawing={drawing}
                onDraw={previewRatio || edit.frame ? undefined : () => setDrawing((value) => !value)}
              />
              <button type="button" onClick={() => setSelection(undefined)}>
                Done
              </button>
            </>
          ) : (
            <TakeControls
              take={take}
              change={change}
              zooms={segments.length}
              moments={moments.length}
              captions={captions}
              swatches={swatches}
              drawing={drawing}
              onDraw={previewRatio || edit.frame ? undefined : () => setDrawing((value) => !value)}
            />
          )}
        </aside>
        <footer>
          <div className="transport">
            <button type="button" onClick={session.toggle} disabled={!renderer}>
              {session.playing ? "Pause" : "Play"}
            </button>
            <Time clock={clock} durationMs={durationMs} />
            <span className="spacer" />
            <span className="hint">Trim</span>
            <button
              type="button"
              onClick={() => trimFromButton(timeMap.toTake(clock.get()), edit.trim.endMs)}
              disabled={!renderer}
            >
              Start here
            </button>
            <button
              type="button"
              onClick={() => trimFromButton(edit.trim.startMs, timeMap.toTake(clock.get()))}
              disabled={!renderer}
            >
              End here
            </button>
            <button type="button" onClick={() => trimFromButton(0, source.durationMs)} disabled={untrimmed}>
              Reset
            </button>
          </div>
          <Tracks
            clock={clock}
            take={take}
            events={events}
            timeMap={timeMap}
            zooms={zoomSpans}
            captions={shownCaptions}
            accents={moments}
            selection={selection}
            onSelect={setSelection}
            onSeek={session.seek}
            onTrim={setTrim}
          />
          <div className="saved-to">
            <SaveStatus state={save.state} />
            <span>
              Changes are saved to <code>.clipmunk/takes/{take.id}/edit.json</code>
            </span>
          </div>
        </footer>
        {chatOpen && (
          <ChatPanel
            client={client}
            clip={{ kind: "take", id: take.id }}
            chips={chips}
            onChips={setChips}
            moment={() => timeMap.toTake(clock.get())}
            edit={{ takeId: take.id, value: take.edit }}
            previewing={previewProposal?.message}
            onPreview={setPreviewProposal}
            beforeKeep={save.flush}
            onApplied={() => void reload()}
            onClose={() => {
              setChatOpen(false);
              setPreviewProposal(undefined);
            }}
          />
        )}
        {/* biome-ignore lint/a11y/useMediaCaption: the speaker's own voice, played with the preview; it has no captions */}
        {source.audio && <audio ref={audio} src={file(source.audio.file)} preload="auto" />}
      </div>
    </Chrome>
  );
}

/** Backdrop swatches after the brand's own colour. */
const DEFAULT_SWATCHES = ["#0b0b0f", "#18181b", "#1e1b4b", "#f4f4f5", "#ffffff"];
