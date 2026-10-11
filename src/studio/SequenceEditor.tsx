import { useEffect, useRef, useState } from "react";
import type { CatalogScene, Issue, Sequence, SequenceItem, TakeSummary } from "../core";
import type { DaemonClient } from "../recorder";
import { Chrome } from "./Chrome";
import { ExportPanel, sizesFor, type DaemonState } from "./daemon";
import { MusicControls } from "./music";

/** Builds a sequence: an ordered list of scenes and takes with a cut or a fade between
 * them. Every change is saved to src/flick/sequences/<id>.sequence.json through the
 * daemon, which also checks that each clip exists.
 */
const SHAPES = [
  { label: "16:9", width: 1920, height: 1080 },
  { label: "1:1", width: 1080, height: 1080 },
  { label: "9:16", width: 1080, height: 1920 },
];
type Choice = { kind: "scene" | "take"; id: string; title: string };

export function SequenceEditor({ id, daemon, scenes, backHref }: { id: string; daemon: DaemonState; scenes: CatalogScene[]; backHref: string }) {
  const client = daemon?.client;
  const [sequence, setSequence] = useState<Sequence>();
  const [takes, setTakes] = useState<TakeSummary[]>([]);
  const [issues, setIssues] = useState<Issue[]>();
  useEffect(() => {
    if (!client) return;
    void client.get<Sequence>(`/v1/sequences/${id}`).then((result) => (result.ok ? setSequence(result.data) : setIssues(result.issues)));
    void client.get<{ takes: TakeSummary[] }>("/v1/takes").then((result) => result.ok && setTakes(result.data.takes));
  }, [client, id]);

  if (sequence && client) return <Editor key={id} initial={sequence} client={client} daemon={daemon} scenes={scenes} takes={takes} backHref={backHref} />;
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
            <strong>This sequence cannot be opened.</strong>
            <ul>{issues.map((issue, index) => <li key={index}>{issue.path && <code>{issue.path}: </code>}{issue.message}</li>)}</ul>
          </div>
        )}
      </div>
    </Chrome>
  );
}

function Editor(props: { initial: Sequence; client: DaemonClient; daemon: DaemonState; scenes: CatalogScene[]; takes: TakeSummary[]; backHref: string }) {
  const { client } = props;
  const [sequence, setSequence] = useState(props.initial);
  const [saveState, setSaveState] = useState<"saved" | "saving" | string>("saved");
  const [exporting, setExporting] = useState(false);
  const saved = useRef(props.initial);
  const pending = useRef<Promise<void>>(Promise.resolve());
  const save = (next: Sequence) =>
    (pending.current = pending.current.then(async () => {
      if (next === saved.current) return;
      setSaveState("saving");
      const result = await client.put<Sequence>(`/v1/sequences/${next.id}`, new Blob([JSON.stringify(next)], { type: "application/json" }));
      if (result.ok) saved.current = next;
      setSaveState(result.ok ? "saved" : result.issues.map((issue) => issue.message).join(" "));
    }));
  useEffect(() => {
    if (sequence === saved.current) return;
    const timer = setTimeout(() => void save(sequence), 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sequence]);
  const latest = useRef(sequence);
  latest.current = sequence;

  const choices: Choice[] = [
    ...props.scenes.map((scene) => ({ kind: "scene" as const, id: scene.id, title: scene.title })),
    ...props.takes.map((take) => ({ kind: "take" as const, id: take.id, title: take.title })),
  ];
  const titleOf = (item: SequenceItem) => choices.find((choice) => choice.kind === item.clip.kind && choice.id === item.clip.id)?.title ?? item.clip.id;
  const [adding, setAdding] = useState("");
  const items = (change: (items: SequenceItem[]) => SequenceItem[]) => setSequence((current) => ({ ...current, items: change(current.items) }));
  const move = (index: number, by: number) =>
    items((list) => {
      const next = [...list];
      const [item] = next.splice(index, 1);
      next.splice(index + by, 0, item!);
      return next;
    });
  // A shape is a ratio, at whatever resolution the sequence is set to.
  const shape = SHAPES.find((candidate) => Math.abs(candidate.width / candidate.height - sequence.width / sequence.height) < 0.01)?.label ?? "custom";

  return (
    <Chrome style={{ position: "fixed", inset: 0, overflow: "auto", background: "#000" }}>
      <div className="take sequence">
        <header>
          <a href={props.backHref}>← Library</a>
          <input className="title" aria-label="Sequence title" value={sequence.title} onChange={(event) => { const title = event.currentTarget.value; setSequence((current) => ({ ...current, title: title || current.title })); }} />
          <span className={saveState === "saved" || saveState === "saving" ? "save" : "save bad"}>{saveState === "saved" ? "Saved" : saveState === "saving" ? "Saving…" : saveState}</span>
          <button type="button" onClick={() => setExporting((value) => !value)}>Export</button>
          <button type="button" onClick={() => confirm("Delete this sequence? Its scenes and takes are kept.") && void client.remove(`/v1/sequences/${sequence.id}`).then(() => location.assign(props.backHref))}>Delete</button>
        </header>
        {exporting && <ExportPanel clip={{ sequenceId: sequence.id }} daemon={props.daemon} before={() => save(latest.current)} />}
        <div className="settings">
          <label>Shape
            <select value={shape} onChange={(event) => { const next = SHAPES.find((candidate) => candidate.label === event.currentTarget.value); if (next) setSequence((current) => {
                // Keep the resolution: the new shape gets the same short side as the current frame.
                const scale = Math.min(Math.min(current.width, current.height) / Math.min(next.width, next.height), 3840 / Math.max(next.width, next.height));
                const size = (value: number) => Math.max(2, Math.round((value * scale) / 2) * 2);
                return { ...current, width: size(next.width), height: size(next.height) };
              }); }}>
              {[...SHAPES.map((candidate) => candidate.label), ...(shape === "custom" ? ["custom"] : [])].map((label) => <option key={label}>{label}</option>)}
            </select>
          </label>
          <label>Resolution
            <select value={`${sequence.width}x${sequence.height}`}
              onChange={(event) => { const [width, height] = event.currentTarget.value.split("x").map(Number) as [number, number]; setSequence((current) => ({ ...current, width, height })); }}>
              {sizesFor(sequence).map((size) => <option key={size.label} value={`${size.width}x${size.height}`}>{size.label === "Original" ? "Current" : size.label} · {size.width}×{size.height}</option>)}
            </select>
          </label>
          <label>Frame rate
            <select value={sequence.fps} onChange={(event) => { const fps = Number(event.currentTarget.value) as 30 | 60; setSequence((current) => ({ ...current, fps })); }}>
              <option value={30}>30 fps</option>
              <option value={60}>60 fps</option>
            </select>
          </label>
          <span className="note">Each clip is fitted inside this frame.</span>
        </div>
        <ol className="clips">
          {sequence.items.map((item, index) => (
            <li key={index}>
              {index > 0 && (
                <div className="join">
                  <select aria-label={`Transition into clip ${index + 1}`} value={item.transition.kind}
                    onChange={(event) => { const kind = event.currentTarget.value as "cut" | "fade"; items((list) => list.map((entry, at) => (at === index ? { ...entry, transition: { ...entry.transition, kind } } : entry))); }}>
                    <option value="cut">Cut</option>
                    <option value="fade">Fade</option>
                  </select>
                  {item.transition.kind === "fade" && (
                    <label>
                      <input type="number" aria-label={`Fade length into clip ${index + 1}, milliseconds`} min={100} max={5000} step={100} value={item.transition.ms}
                        onChange={(event) => { const ms = Math.max(0, Math.min(5000, Number(event.currentTarget.value) || 0)); items((list) => list.map((entry, at) => (at === index ? { ...entry, transition: { ...entry.transition, ms } } : entry))); }} /> ms
                    </label>
                  )}
                </div>
              )}
              <div className="clip">
                <span className="kind">{item.clip.kind}</span>
                <b>{titleOf(item)}</b>
                <button type="button" aria-label="Move up" onClick={() => move(index, -1)} disabled={index === 0}>↑</button>
                <button type="button" aria-label="Move down" onClick={() => move(index, 1)} disabled={index === sequence.items.length - 1}>↓</button>
                <button type="button" aria-label="Remove clip" onClick={() => items((list) => list.filter((_, at) => at !== index))} disabled={sequence.items.length === 1}>Remove</button>
              </div>
            </li>
          ))}
        </ol>
        <div className="settings">
          <label>Add a clip
            <select value={adding} onChange={(event) => setAdding(event.currentTarget.value)}>
              <option value="">Choose a scene or take…</option>
              {choices.map((choice) => <option key={`${choice.kind}:${choice.id}`} value={`${choice.kind}:${choice.id}`}>{choice.kind === "scene" ? "Scene" : "Take"}: {choice.title}</option>)}
            </select>
          </label>
          <button type="button" disabled={!adding} onClick={() => {
            const [kind, clipId] = adding.split(":") as ["scene" | "take", string];
            items((list) => [...list, { clip: { kind, id: clipId }, transition: { kind: "fade", ms: 500 } }]);
            setAdding("");
          }}>Add</button>
        </div>
        <div className="musicbox">
          <MusicControls value={sequence.music} clipKey={`sequence:${sequence.id}`} onChange={(music) => setSequence(({ music: _previous, ...rest }) => (music ? { ...rest, music } : rest))} />
        </div>
        <p className="note">There is no live preview of a whole sequence yet: open a clip to see it, and export to see them joined.</p>
      </div>
    </Chrome>
  );
}
