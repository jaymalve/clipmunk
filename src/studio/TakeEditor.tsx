import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { installBridge, PROGRESS_BINDING, WRITE_BINDING } from "../bridge";
import { createTakeRenderer, type TakeRenderer } from "../compositor";
import {
  type Issue,
  parseEvents,
  resolveZoomTracks,
  type Take,
  type TakeEdit,
  type TakeEvent,
  TakeEventSchema,
  takeMoments,
  zoomSegments,
} from "../core";
import { type Clock, createClock } from "../react";
import type { DaemonClient } from "../recorder";
import { Chrome } from "./Chrome";
import { type DaemonState, ExportPanel } from "./daemon";
import { MusicControls, useMusicPreview } from "./music";
import { useClipSession } from "./session";

/** The take editor: a live preview of the composited take, a timeline, and the controls
 * for everything in `take.edit`. Edits are saved to take.json through the daemon, so the
 * file stays the source of truth and a coding agent can edit the same take.
 */
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const CANVASES = [
  { label: "16:9", width: 1920, height: 1080 },
  { label: "4:3", width: 1440, height: 1080 },
  { label: "1:1", width: 1080, height: 1080 },
  { label: "9:16", width: 1080, height: 1920 },
];

export function TakeEditor({ id, daemon, backHref }: { id: string; daemon: DaemonState; backHref: string }) {
  const [loaded, setLoaded] = useState<{ take: Take; revision: string; events: TakeEvent[] }>();
  const [issues, setIssues] = useState<Issue[]>();
  const client = daemon?.client;
  useEffect(() => {
    if (!client) return;
    let current = true;
    void (async () => {
      const result = await client.get<{ take: Take; revision: string }>(`/v1/takes/${id}`);
      if (!current) return;
      if (!result.ok) return setIssues(result.issues);
      const log = await fetch(client.url(`/v1/takes/${id}/files/${result.data.take.source.events.file}`)).then(
        (response) => (response.ok ? response.text() : ""),
        () => "",
      );
      if (current) setLoaded({ ...result.data, events: parseEvents(log, TakeEventSchema) });
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
        {issues && (
          <div className="issues" role="alert">
            <ul>
              {issues.map((issue, index) => (
                <li key={index}>{issue.message}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Chrome>
  );
}

function Editor(props: {
  take: Take;
  revision: string;
  events: TakeEvent[];
  client: DaemonClient;
  daemon: DaemonState;
  backHref: string;
}) {
  const { client, events } = props;
  const [take, setTake] = useState(props.take);
  const [renderer, setRenderer] = useState<TakeRenderer>();
  const [failure, setFailure] = useState<string>();
  const [saveState, setSaveState] = useState<"saved" | "saving" | string>("saved");
  const [exporting, setExporting] = useState(false);
  // The canvas lives inside the studio's shadow root, which mounts a render later than this component.
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const [clock] = useState(() => createClock());
  const durationMs = Math.max(0, take.edit.trim.endMs - take.edit.trim.startMs);
  const session = useClipSession(clock, durationMs, !!renderer);
  const file = useCallback((name: string) => client.url(`/v1/takes/${take.id}/files/${name}`), [client, take.id]);

  // Open the media once; every later change goes through renderer.update.
  useEffect(() => {
    let current = true;
    let opened: TakeRenderer | undefined;
    if (!canvas) return;
    createTakeRenderer({ take: props.take, events, fileUrl: file, canvas }).then(
      (value) => {
        if (!current) return value.close();
        opened = value;
        setRenderer(value);
      },
      (error: unknown) => current && setFailure(error instanceof Error ? error.message : String(error)),
    );
    return () => {
      current = false;
      opened?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvas]);

  useEffect(() => {
    if (!renderer) return;
    renderer.update(take);
    void renderer.renderAt(clock.get());
    return clock.subscribe(() => void renderer.renderAt(clock.get()));
  }, [renderer, take, clock]);

  // Save edits a moment after they stop changing. The revision detects a file edited elsewhere.
  const revision = useRef(props.revision);
  const saved = useRef(props.take);
  const pending = useRef<Promise<void>>(Promise.resolve());
  const save = useCallback(
    (next: Take) => {
      pending.current = pending.current.then(async () => {
        if (next === saved.current) return;
        setSaveState("saving");
        const result = await client.patch<{ take: Take; revision: string }>(`/v1/takes/${next.id}`, {
          edit: next.edit,
          title: next.title,
          revision: revision.current,
        });
        if (result.ok) {
          revision.current = result.data.revision;
          saved.current = next;
          setSaveState("saved");
        } else setSaveState(result.issues[0]!.message);
      });
      return pending.current;
    },
    [client],
  );
  useEffect(() => {
    if (take === saved.current) return;
    const timer = setTimeout(() => void save(take), 500);
    return () => clearTimeout(timer);
  }, [take, save]);
  const latest = useRef(take);
  latest.current = take;

  // Voice follows the clock while playing. Export mixes the same file with FFmpeg.
  const voice = take.source.audio;
  useEffect(() => {
    const element = audio.current;
    if (!element || !voice) return;
    element.volume = Math.min(1, take.edit.audio.gain);
    element.muted = take.edit.audio.muted;
    if (!session.playing) return element.pause();
    element.currentTime = Math.max(0, (take.edit.trim.startMs + clock.get() - voice.offsetMs) / 1000);
    void element.play().catch(() => {});
  }, [session.playing, voice, take.edit.audio, take.edit.trim.startMs, clock]);

  const moments = useMemo(() => takeMoments(take, events), [take.edit.trim, events]); // eslint-disable-line react-hooks/exhaustive-deps
  useMusicPreview({
    music: take.edit.music,
    clip: { key: `take:${take.id}`, durationMs, momentsMs: moments },
    clock,
    playing: session.playing,
  });

  // The exporter drives this page through the same renderer the preview uses.
  useEffect(() => {
    if (!renderer) return;
    return installBridge({
      version: 1,
      kind: "take",
      durationMs: renderer.durationMs,
      width: take.edit.canvas.width,
      height: take.edit.canvas.height,
      selector: "canvas[data-flick-take]",
      ready: async () => renderer.renderAt(clock.get()),
      async seek(timeMs) {
        session.seek(timeMs);
        await renderer.renderAt(clock.get());
      },
      async encode(job) {
        const bindings = window as unknown as Record<string, ((...args: unknown[]) => Promise<void>) | undefined>;
        const write = bindings[WRITE_BINDING],
          progress = bindings[PROGRESS_BINDING];
        if (!write) throw new Error("No writer is attached to this page.");
        const scale = job.height
          ? job.height / take.edit.canvas.height
          : job.width
            ? job.width / take.edit.canvas.width
            : 1;
        const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
        const size = {
          width: job.width ?? even(take.edit.canvas.width * scale),
          height: job.height ?? even(take.edit.canvas.height * scale),
        };
        return renderer.encode(
          { fps: job.fps, ...size },
          async (data, position) => {
            // Binary crosses to the exporter as base64, in pieces small enough for one call.
            let text = "";
            for (let i = 0; i < data.length; i += 32768) text += String.fromCharCode(...data.subarray(i, i + 32768));
            await write(btoa(text), position);
          },
          (done, total) => void progress?.(done, total),
        );
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderer, take.edit.canvas.width, take.edit.canvas.height, durationMs, session.seek]);

  const edit = (change: (edit: TakeEdit) => TakeEdit) =>
    setTake((current) => ({ ...current, edit: change(current.edit) }));
  const { edit: e, source } = take;
  // Derived here, not read back from the renderer, which only learns of an edit after this render.
  const segments = useMemo(
    () => zoomSegments(resolveZoomTracks({ zoom: e.zoom }, events, source)),
    [e.zoom, events, source],
  );
  const setTrim = (startMs: number, endMs: number) => {
    const start = Math.max(0, Math.min(startMs, source.durationMs - 100));
    const end = Math.max(start + 100, Math.min(endMs, source.durationMs));
    session.seek(0);
    edit((current) => ({ ...current, trim: { startMs: Math.round(start), endMs: Math.round(end) } }));
  };

  return (
    <Chrome style={{ position: "fixed", inset: 0, background: "#000" }}>
      <div className="editor">
        <header>
          <a href={props.backHref}>← Library</a>
          <input
            className="title"
            aria-label="Take title"
            value={take.title}
            onChange={(event) =>
              setTake((current) => ({ ...current, title: event.currentTarget.value || current.title }))
            }
          />
          <span className={saveState === "saved" || saveState === "saving" ? "save" : "save bad"}>
            {saveState === "saved" ? "Saved" : saveState === "saving" ? "Saving…" : saveState}
          </span>
          <button type="button" onClick={() => setExporting((value) => !value)} disabled={!renderer}>
            Export
          </button>
          <button
            type="button"
            onClick={() =>
              confirm("Delete this take and its media?") &&
              void client.remove(`/v1/takes/${take.id}`).then(() => location.assign(props.backHref))
            }
          >
            Delete
          </button>
        </header>
        {exporting && (
          <ExportPanel
            clip={{ takeId: take.id }}
            daemon={props.daemon}
            before={() => save(latest.current)}
            frame={e.canvas}
          />
        )}
        <div className="stage">
          <canvas ref={setCanvas} data-flick-take={take.id} width={e.canvas.width} height={e.canvas.height} />
          {failure && (
            <div className="issues" role="alert">
              <strong>This take cannot be previewed.</strong> {failure}
            </div>
          )}
          {!renderer && !failure && <p className="note">Loading the recording…</p>}
        </div>
        <aside>
          <Group title="Zoom">
            <Select
              label="Mode"
              value={e.zoom.mode}
              options={e.zoom.mode === "manual" ? ["auto", "manual", "off"] : ["auto", "off"]}
              onChange={(mode) =>
                edit((c) => ({
                  ...c,
                  zoom:
                    mode === "auto"
                      ? { mode: "auto", params: c.zoom.mode === "auto" ? c.zoom.params : AUTO }
                      : mode === "off"
                        ? { mode: "off" }
                        : c.zoom,
                }))
              }
            />
            {e.zoom.mode === "auto" && (
              <>
                <Slider
                  label="Strength"
                  value={e.zoom.params.maxScale}
                  min={1}
                  max={4}
                  step={0.1}
                  format={(v) => `${v.toFixed(1)}×`}
                  onChange={(maxScale) =>
                    edit((c) =>
                      c.zoom.mode === "auto"
                        ? {
                            ...c,
                            zoom: {
                              ...c.zoom,
                              params: {
                                ...c.zoom.params,
                                maxScale,
                                minScale: Math.min(c.zoom.params.minScale, maxScale),
                              },
                            },
                          }
                        : c,
                    )
                  }
                />
                <Slider
                  label="Hold after action"
                  value={e.zoom.params.holdMs}
                  min={300}
                  max={4000}
                  step={100}
                  format={seconds}
                  onChange={(holdMs) =>
                    edit((c) =>
                      c.zoom.mode === "auto" ? { ...c, zoom: { ...c.zoom, params: { ...c.zoom.params, holdMs } } } : c,
                    )
                  }
                />
                <p className="hint">
                  {segments.length
                    ? `${segments.length} zoom${segments.length === 1 ? "" : "s"} from your clicks and typing`
                    : "No clicks or typing in this take, so there is nothing to zoom to."}
                </p>
              </>
            )}
            {e.zoom.mode === "manual" && <p className="hint">Zoom keyframes are hand-written in take.json.</p>}
          </Group>
          <Group title="Cursor">
            <Check
              label="Show cursor"
              value={e.cursor.visible}
              onChange={(visible) => edit((c) => ({ ...c, cursor: { ...c.cursor, visible } }))}
            />
            <Slider
              label="Size"
              value={e.cursor.size}
              min={0.5}
              max={4}
              step={0.1}
              format={(v) => `${v.toFixed(1)}×`}
              onChange={(size) => edit((c) => ({ ...c, cursor: { ...c.cursor, size } }))}
            />
            <Slider
              label="Smoothing"
              value={e.cursor.smoothing}
              min={0}
              max={1}
              step={0.05}
              format={(v) => `${Math.round(v * 100)}%`}
              onChange={(smoothing) => edit((c) => ({ ...c, cursor: { ...c.cursor, smoothing } }))}
            />
            <Check
              label="Click ripple"
              value={e.cursor.clickEffect === "ripple"}
              onChange={(on) => edit((c) => ({ ...c, cursor: { ...c.cursor, clickEffect: on ? "ripple" : "none" } }))}
            />
          </Group>
          {source.cam && (
            <Group title="Camera">
              <Check
                label="Show camera"
                value={e.cam.visible}
                onChange={(visible) => edit((c) => ({ ...c, cam: { ...c.cam, visible } }))}
              />
              <Select
                label="Shape"
                value={e.cam.shape}
                options={["circle", "rounded"]}
                onChange={(shape) =>
                  edit((c) => ({ ...c, cam: { ...c.cam, shape: shape as TakeEdit["cam"]["shape"] } }))
                }
              />
              <Select
                label="Corner"
                value={e.cam.corner}
                options={["br", "bl", "tr", "tl"]}
                names={{ br: "Bottom right", bl: "Bottom left", tr: "Top right", tl: "Top left" }}
                onChange={(corner) =>
                  edit((c) => ({ ...c, cam: { ...c.cam, corner: corner as TakeEdit["cam"]["corner"] } }))
                }
              />
              <Slider
                label="Size"
                value={e.cam.size}
                min={0.08}
                max={0.5}
                step={0.01}
                format={(v) => `${Math.round(v * 100)}%`}
                onChange={(size) => edit((c) => ({ ...c, cam: { ...c.cam, size } }))}
              />
              <Check
                label="Mirror"
                value={e.cam.mirror}
                onChange={(mirror) => edit((c) => ({ ...c, cam: { ...c.cam, mirror } }))}
              />
            </Group>
          )}
          <Group title="Frame">
            <Select
              label="Shape"
              value={
                CANVASES.find((c) => c.width === e.canvas.width && c.height === e.canvas.height)?.label ?? "custom"
              }
              options={[
                ...CANVASES.map((c) => c.label),
                ...(CANVASES.some((c) => c.width === e.canvas.width && c.height === e.canvas.height) ? [] : ["custom"]),
              ]}
              onChange={(label) => {
                const size = CANVASES.find((c) => c.label === label);
                if (size) edit((c) => ({ ...c, canvas: { ...c.canvas, width: size.width, height: size.height } }));
              }}
            />
            <label className="field">
              <span>Background</span>
              <input
                type="color"
                value={/^#[0-9a-f]{6}$/i.test(e.canvas.background) ? e.canvas.background : "#0b0b0f"}
                onChange={(event) => {
                  const background = event.currentTarget.value;
                  edit((c) => ({ ...c, canvas: { ...c.canvas, background } }));
                }}
              />
            </label>
            <Slider
              label="Padding"
              value={e.canvas.padding}
              min={0}
              max={0.3}
              step={0.01}
              format={(v) => `${Math.round(v * 100)}%`}
              onChange={(padding) => edit((c) => ({ ...c, canvas: { ...c.canvas, padding } }))}
            />
            <Slider
              label="Corner radius"
              value={e.canvas.radius}
              min={0}
              max={80}
              step={1}
              format={(v) => `${v}px`}
              onChange={(radius) => edit((c) => ({ ...c, canvas: { ...c.canvas, radius } }))}
            />
            <Slider
              label="Shadow"
              value={e.canvas.shadow}
              min={0}
              max={1}
              step={0.05}
              format={(v) => `${Math.round(v * 100)}%`}
              onChange={(shadow) => edit((c) => ({ ...c, canvas: { ...c.canvas, shadow } }))}
            />
          </Group>
          <Group title="Music">
            <MusicControls
              value={e.music}
              hasVoice={!!voice}
              clipKey={`take:${take.id}`}
              moments={moments.length}
              onChange={(music) => edit(({ music: _previous, ...rest }) => (music ? { ...rest, music } : rest))}
            />
          </Group>
          {voice && (
            <Group title="Voice">
              <Check
                label="Mute"
                value={e.audio.muted}
                onChange={(muted) => edit((c) => ({ ...c, audio: { ...c.audio, muted } }))}
              />
              <Slider
                label="Volume"
                value={e.audio.gain}
                min={0}
                max={2}
                step={0.05}
                format={(v) => `${Math.round(v * 100)}%`}
                onChange={(gain) => edit((c) => ({ ...c, audio: { ...c.audio, gain } }))}
              />
              <Check
                label="Even out loudness on export"
                value={e.audio.normalize}
                onChange={(normalize) => edit((c) => ({ ...c, audio: { ...c.audio, normalize } }))}
              />
            </Group>
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
              onClick={() => setTrim(e.trim.startMs + clock.get(), e.trim.endMs)}
              disabled={!renderer}
            >
              Start here
            </button>
            <button
              type="button"
              onClick={() => setTrim(e.trim.startMs, e.trim.startMs + clock.get())}
              disabled={!renderer}
            >
              End here
            </button>
            <button
              type="button"
              onClick={() => setTrim(0, source.durationMs)}
              disabled={e.trim.startMs === 0 && e.trim.endMs === source.durationMs}
            >
              Reset
            </button>
          </div>
          <Timeline clock={clock} take={take} segments={segments} onSeek={session.seek} />
        </footer>
        {voice && <audio ref={audio} src={file(voice.file)} preload="auto" />}
      </div>
    </Chrome>
  );
}

const AUTO = { minScale: 1.25, maxScale: 2.2, mergeGapMs: 2500, leadMs: 300, holdMs: 1500, easeMs: 700 };

function Time({ clock, durationMs }: { clock: Clock; durationMs: number }) {
  const timeMs = useSyncExternalStore(clock.subscribe, clock.get, clock.get);
  return (
    <span className="time">
      {(timeMs / 1000).toFixed(2)}s / {(durationMs / 1000).toFixed(2)}s
    </span>
  );
}

/** The whole recording left to right: the kept part, where it zooms, and the playhead. Click or drag to seek. */
function Timeline({
  clock,
  take,
  segments,
  onSeek,
}: {
  clock: Clock;
  take: Take;
  segments: { startMs: number; endMs: number }[];
  onSeek: (clipMs: number) => void;
}) {
  const timeMs = useSyncExternalStore(clock.subscribe, clock.get, clock.get);
  const total = Math.max(1, take.source.durationMs);
  const { startMs, endMs } = take.edit.trim;
  const percent = (ms: number) => `${(Math.max(0, Math.min(total, ms)) / total) * 100}%`;
  const seekTo = (event: React.PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    onSeek(((event.clientX - box.left) / box.width) * total - startMs);
  };
  return (
    <div
      className="timeline"
      role="slider"
      aria-label="Take time"
      aria-valuemin={0}
      aria-valuemax={Math.round(endMs - startMs)}
      aria-valuenow={Math.round(timeMs)}
      tabIndex={0}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        seekTo(event);
      }}
      onPointerMove={(event) => event.buttons === 1 && seekTo(event)}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") onSeek(timeMs - 100);
        if (event.key === "ArrowRight") onSeek(timeMs + 100);
      }}
    >
      <div className="kept" style={{ left: percent(startMs), width: percent(endMs - startMs) }} />
      {segments.map((segment, index) => (
        <div
          key={index}
          className="zoom"
          title="Zoom"
          style={{ left: percent(segment.startMs), width: percent(segment.endMs - segment.startMs) }}
        />
      ))}
      <div className="playhead" style={{ left: percent(startMs + timeMs) }} />
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  );
}
function Slider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(event) => props.onChange(Number(event.currentTarget.value))}
      />
      <output>{props.format(props.value)}</output>
    </label>
  );
}
function Check({ label, value, onChange }: { label: string; value: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="field check">
      <input type="checkbox" checked={value} onChange={(event) => onChange(event.currentTarget.checked)} />
      <span>{label}</span>
    </label>
  );
}
function Select({
  label,
  value,
  options,
  names,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  names?: Record<string, string>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.currentTarget.value)}>
        {options.map((option) => (
          <option key={option} value={option}>
            {names?.[option] ?? option[0]!.toUpperCase() + option.slice(1)}
          </option>
        ))}
      </select>
    </label>
  );
}
