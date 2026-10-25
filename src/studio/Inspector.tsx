import {
  type Caption,
  EASINGS,
  type Easing,
  resolveZoomTracks,
  type Take,
  type TakeEdit,
  type TakeEvent,
  zoomSegments,
} from "../core";
import { Group, Select, Slider, times } from "./fields";

/** The inspector for one thing selected on the timeline. Editing a zoom stores the zooms as
 * keyframes (manual mode), because only keyframes can hold a hand-set value.
 */
type Change = (change: (edit: TakeEdit) => TakeEdit) => void;
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

export function ZoomInspector(props: {
  take: Take;
  events: readonly TakeEvent[];
  index: number;
  change: Change;
  onDone: () => void;
}) {
  const { take, events, index } = props;
  const tracks = resolveZoomTracks(take.edit, events, take.source);
  const segment = zoomSegments(tracks)[index];
  if (!segment)
    return (
      <Group title="Zoom">
        <p className="hint">This zoom is gone.</p>
        <button type="button" onClick={props.onDone}>
          Back
        </button>
      </Group>
    );
  const inside = (timeMs: number) => timeMs >= segment.startMs && timeMs <= segment.endMs;
  // What the zoom is aimed at: the first named element clicked in it.
  const click = events.find((event) => event.k === "down" && inside(event.t) && event.el);
  const target = click?.k === "down" ? click.el : undefined;
  const scaleTrack = tracks.find((track) => track.property === "scale");
  const easing = (scaleTrack?.keyframes.find((frame) => inside(frame.timeMs))?.easing ?? "cinematic") as Easing;
  const update = (edit: (frame: { timeMs: number; value: number; easing: Easing }, property: string) => object) =>
    props.change((current) => ({
      ...current,
      zoom: {
        mode: "manual",
        tracks: resolveZoomTracks(current, events, take.source).map((track) => ({
          ...track,
          keyframes: track.keyframes.map((frame) =>
            inside(frame.timeMs) ? { ...frame, ...edit(frame, track.property) } : frame,
          ),
        })),
      },
    }));
  return (
    <Group title={`Zoom ${index + 1}`}>
      <p className="hint">
        {seconds(segment.startMs)} to {seconds(segment.endMs)}
        {take.edit.zoom.mode === "auto" ? ". Editing it stores the zooms as keyframes." : "."}
      </p>
      <div className="field">
        <span>Target</span>
        <code className="target">{target?.sel ?? "the pointer"}</code>
      </div>
      <Slider
        label="Scale"
        value={segment.scale}
        min={1.1}
        max={4}
        step={0.1}
        format={times}
        onChange={(scale) =>
          update((frame, property) => (property === "scale" && frame.value > 1.0001 ? { value: scale } : {}))
        }
      />
      <Select label="Easing" value={easing} options={EASINGS} onChange={(value) => update(() => ({ easing: value }))} />
      <button type="button" onClick={props.onDone}>
        Done
      </button>
    </Group>
  );
}

export function CaptionInspector(props: { caption?: Caption; change: Change; onDone: () => void }) {
  const { caption } = props;
  if (!caption) return null;
  const setText = (text: string) =>
    props.change((current) => ({
      ...current,
      captions: {
        ...current.captions,
        items: [
          ...current.captions.items.filter((item) => item.atMs !== caption.atMs),
          { atMs: caption.atMs, durMs: caption.durMs, text, source: "manual" as const },
        ].sort((a, b) => a.atMs - b.atMs),
      },
    }));
  return (
    <Group title="Caption">
      <p className="hint">
        {seconds(caption.atMs)}, {seconds(caption.durMs)} long{caption.source === "auto" ? ", from your clicks" : ""}.
      </p>
      <label className="field">
        <span>Text</span>
        <input
          type="text"
          aria-label="Caption text"
          value={caption.text}
          maxLength={120}
          onChange={(event) => setText(event.currentTarget.value)}
        />
      </label>
      <div className="row">
        <button type="button" onClick={() => setText("")}>
          Hide this caption
        </button>
        <button type="button" onClick={props.onDone}>
          Done
        </button>
      </div>
    </Group>
  );
}
