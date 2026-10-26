import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildTimeMap,
  type Issue,
  parseEvents,
  resolveCaptions,
  resolveZoomTracks,
  type Span,
  type Take,
  type TakeEdit,
  type TakeEvent,
  TakeEventSchema,
  takeMoments,
  zoomSegments,
} from "../core";
import { createClock } from "../react";
import type { DaemonClient } from "../recorder";
import { SaveStatus, useAutosave } from "./autosave";
import { Chrome } from "./Chrome";
import { type DaemonState, ExportPanel } from "./daemon";
import { IssueList } from "./IssueList";
import { useMusicPreview } from "./music";
import { useClipSession } from "./session";
import { TakeControls } from "./TakeControls";
import { Time, Timeline } from "./Timeline";
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
  usePreview(renderer, take, clock);
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
  const save = useAutosave(take, async (next) => {
    const body = { edit: next.edit, title: next.title, revision: revision.current };
    const result = await client.patch<{ take: Take; revision: string }>(`/v1/takes/${next.id}`, body);
    if (!result.ok) return result.issues[0]!.message;
    revision.current = result.data.revision;
    return undefined;
  });

  const change = (update: (edit: TakeEdit) => TakeEdit) =>
    setTake((current) => ({ ...current, edit: update(current.edit) }));
  const setTrim = (startMs: number, endMs: number) => {
    const start = Math.max(0, Math.min(startMs, source.durationMs - 100));
    const end = Math.max(start + 100, Math.min(endMs, source.durationMs));
    session.seek(0);
    change((current) => ({ ...current, trim: { startMs: Math.round(start), endMs: Math.round(end) } }));
  };
  const remove = () =>
    confirm("Delete this take and its media?") &&
    void client.remove(`/v1/takes/${take.id}`).then(() => location.assign(props.backHref));
  const untrimmed = edit.trim.startMs === 0 && edit.trim.endMs === source.durationMs;

  return (
    <Chrome style={{ position: "fixed", inset: 0, background: "#000" }}>
      <div className="editor">
        <header>
          <a href={props.backHref}>← Library</a>
          <input
            className="title"
            aria-label="Take title"
            value={take.title}
            onChange={(event) => {
              const title = event.currentTarget.value;
              setTake((current) => ({ ...current, title: title || current.title }));
            }}
          />
          <SaveStatus state={save.state} />
          <button type="button" onClick={() => setExporting((value) => !value)} disabled={!renderer}>
            Export
          </button>
          <button type="button" onClick={remove}>
            Delete
          </button>
        </header>
        {exporting && (
          <ExportPanel clip={{ takeId: take.id }} daemon={props.daemon} before={save.flush} frame={edit.canvas} />
        )}
        <div className="stage">
          <canvas ref={setCanvas} data-clipmunk-take={take.id} width={edit.canvas.width} height={edit.canvas.height} />
          {failure && (
            <div className="issues" role="alert">
              <strong>This take cannot be previewed.</strong> {failure}
            </div>
          )}
          {!renderer && !failure && <p className="note">Loading the recording…</p>}
        </div>
        <TakeControls
          take={take}
          change={change}
          zooms={segments.length}
          moments={moments.length}
          captions={captions}
        />
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
              onClick={() => setTrim(timeMap.toTake(clock.get()), edit.trim.endMs)}
              disabled={!renderer}
            >
              Start here
            </button>
            <button
              type="button"
              onClick={() => setTrim(edit.trim.startMs, timeMap.toTake(clock.get()))}
              disabled={!renderer}
            >
              End here
            </button>
            <button type="button" onClick={() => setTrim(0, source.durationMs)} disabled={untrimmed}>
              Reset
            </button>
          </div>
          <Timeline clock={clock} take={take} timeMap={timeMap} segments={segments} onSeek={session.seek} />
        </footer>
        {/* biome-ignore lint/a11y/useMediaCaption: the speaker's own voice, played with the preview; it has no captions */}
        {source.audio && <audio ref={audio} src={file(source.audio.file)} preload="auto" />}
      </div>
    </Chrome>
  );
}
