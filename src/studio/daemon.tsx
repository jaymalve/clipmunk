import { useEffect, useState } from "react";
import { EXPORT_FPS, type Issue } from "../core";
import { connectDaemon, type DaemonClient, type DaemonProblem, type DaemonStatus } from "../recorder";

/** The studio's connection to the local daemon: `undefined` while checking, a problem when there is none. */
export type DaemonConnection = { client: DaemonClient; status: DaemonStatus; problem?: undefined };
export type DaemonState = DaemonConnection | { problem: DaemonProblem; client?: undefined } | undefined;
export function useDaemon(): DaemonState {
  const [state, setState] = useState<DaemonState>();
  useEffect(() => {
    let current = true;
    void connectDaemon().then((value) => current && setState(value));
    return () => {
      current = false;
    };
  }, []);
  return state;
}

/** Output sizes by their short side, keeping the clip's own shape. No side may exceed 3840 pixels. */
const RESOLUTIONS = [
  { label: "720p", short: 720 },
  { label: "1080p", short: 1080 },
  { label: "1440p", short: 1440 },
  { label: "4K", short: 2160 },
];
const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
export function sizesFor(frame: { width: number; height: number }) {
  const own = { label: "Original", width: even(frame.width), height: even(frame.height) };
  const scaled = RESOLUTIONS.map(({ label, short }) => {
    const scale = Math.min(short / Math.min(frame.width, frame.height), 3840 / Math.max(frame.width, frame.height));
    return { label, width: even(frame.width * scale), height: even(frame.height * scale) };
  });
  // Drop a preset that lands on the clip's own size, so the list has no duplicate.
  return [own, ...scaled.filter((size) => size.width !== own.width || size.height !== own.height)];
}

type ExportedFile = { output: string; elapsedMs: number };
type JobState =
  | { phase: "idle" }
  | { phase: "running"; job: string; done: number; total: number }
  | { phase: "done"; result: ExportedFile }
  | { phase: "failed"; issues: Issue[] };

/** Export from the studio. With a daemon it runs the render and shows progress; without one it shows the command. */
/** `clip` is `{ sceneId }` or `{ takeId }`; `before` runs first (the take editor saves pending edits). */
export type ExportClip = { sceneId: string } | { takeId: string } | { sequenceId: string };
/** `frame` is the clip's own size; with it the panel offers a choice of output resolution. */
export function ExportPanel({
  clip,
  daemon,
  before,
  frame,
}: {
  clip: ExportClip;
  daemon: DaemonState;
  before?: () => Promise<void>;
  frame?: { width: number; height: number };
}) {
  const [fps, setFps] = useState<number>(60);
  const [state, setState] = useState<JobState>({ phase: "idle" });
  const sizes = frame && !("sequenceId" in clip) ? sizesFor(frame) : [];
  const [sizeLabel, setSizeLabel] = useState("Original");
  const size = sizes.find((candidate) => candidate.label === sizeLabel) ?? sizes[0];
  const flag =
    "sceneId" in clip
      ? `--scene ${clip.sceneId}`
      : "takeId" in clip
        ? `--take ${clip.takeId}`
        : `--sequence ${clip.sequenceId}`;
  const command = `npx flick export ${flag} --url ${location.origin}${size && size.label !== "Original" ? ` --size ${size.width}x${size.height}` : ""}`;
  // A sequence carries its own frame rate.
  const fpsChoices = "sceneId" in clip ? EXPORT_FPS : "takeId" in clip ? ([30, 60] as const) : [];
  if (!daemon?.client)
    return (
      <div className="command">
        <span>Run in your project:</span>
        {sizes.length > 0 && (
          <select
            value={size!.label}
            onChange={(event) => setSizeLabel(event.currentTarget.value)}
            aria-label="Resolution"
          >
            {sizes.map((candidate) => (
              <option key={candidate.label} value={candidate.label}>
                {candidate.label} · {candidate.width}×{candidate.height}
              </option>
            ))}
          </select>
        )}
        <code>{command}</code>
        <button type="button" onClick={() => void navigator.clipboard?.writeText(command)}>
          Copy
        </button>
      </div>
    );

  const start = async () => {
    await before?.();
    const started = await daemon.client.post<{ job: string }>("/v1/exports", {
      ...clip,
      ...(fpsChoices.length ? { fps } : {}),
      ...(size ? { width: size.width, height: size.height } : {}),
    });
    if (!started.ok) return setState({ phase: "failed", issues: started.issues });
    const job = started.data.job;
    setState({ phase: "running", job, done: 0, total: 0 });
    const events = new EventSource(daemon.client.url(`/v1/jobs/${job}/events`));
    events.onmessage = (message) => {
      const event = JSON.parse(message.data as string) as
        | { type: "progress"; done: number; total: number }
        | { type: "done"; data: ExportedFile }
        | { type: "failed"; issues: Issue[] };
      if (event.type === "progress") return setState({ phase: "running", job, done: event.done, total: event.total });
      events.close();
      setState(
        event.type === "done" ? { phase: "done", result: event.data } : { phase: "failed", issues: event.issues },
      );
    };
    events.onerror = () => {
      events.close();
      setState((current) =>
        current.phase === "running"
          ? {
              phase: "failed",
              issues: [{ code: "daemon-unreachable", message: "Lost the connection to the Flick daemon." }],
            }
          : current,
      );
    };
  };

  return (
    <div className="command">
      {state.phase === "running" ? (
        <>
          <span>
            Rendering
            {state.total
              ? "sequenceId" in clip
                ? ` ${Math.round((state.done / state.total) * 100)}%`
                : ` ${state.done}/${state.total} frames`
              : "…"}
          </span>
          <progress max={state.total || 1} value={state.done} style={{ flex: 1 }} />
          <button type="button" onClick={() => void daemon.client.remove(`/v1/jobs/${state.job}`)}>
            Cancel
          </button>
        </>
      ) : (
        <>
          {state.phase === "done" && (
            <code>
              Wrote {state.result.output} (rendered in {(state.result.elapsedMs / 1000).toFixed(1)} s)
            </code>
          )}
          {state.phase === "failed" && (
            <code style={{ color: "#fca5a5" }}>{state.issues.map((issue) => issue.message).join(" ")}</code>
          )}
          {state.phase === "idle" && <span style={{ flex: 1 }}>Render to an MP4 in .flick/exports</span>}
          {sizes.length > 0 && (
            <select
              value={size!.label}
              onChange={(event) => setSizeLabel(event.currentTarget.value)}
              aria-label="Resolution"
            >
              {sizes.map((candidate) => (
                <option key={candidate.label} value={candidate.label}>
                  {candidate.label} · {candidate.width}×{candidate.height}
                </option>
              ))}
            </select>
          )}
          {fpsChoices.length > 0 && (
            <select value={fps} onChange={(event) => setFps(Number(event.currentTarget.value))} aria-label="Frame rate">
              {fpsChoices.map((value) => (
                <option key={value} value={value}>
                  {value} fps
                </option>
              ))}
            </select>
          )}
          <button type="button" onClick={() => void start()}>
            {state.phase === "idle" ? "Render" : "Render again"}
          </button>
        </>
      )}
    </div>
  );
}
