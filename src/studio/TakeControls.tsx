import type { RedactEntry, Take, TakeEdit } from "../core";
import { Check, Group, percent, Select, Slider, times } from "./fields";
import { MusicControls } from "./music";

/** The take editor's side panel: one group per part of `take.edit`. */
const AUTO_ZOOM = { minScale: 1.25, maxScale: 2.2, mergeGapMs: 2500, leadMs: 300, holdMs: 1500, easeMs: 700 };
const CANVASES = [
  { label: "16:9", width: 1920, height: 1080 },
  { label: "4:3", width: 1440, height: 1080 },
  { label: "1:1", width: 1080, height: 1080 },
  { label: "9:16", width: 1080, height: 1920 },
];
const CORNERS = { br: "Bottom right", bl: "Bottom left", tr: "Top right", tl: "Top left" };

type Change = (change: (edit: TakeEdit) => TakeEdit) => void;
type Section = { edit: TakeEdit; change: Change };
/** Merge new values into one object-valued part of the edit. */
const set =
  <K extends "cursor" | "cam" | "canvas" | "audio">(change: Change, key: K) =>
  (values: Partial<TakeEdit[K]>) =>
    change((edit) => ({ ...edit, [key]: { ...edit[key], ...values } }));

function ZoomControls({ edit, change, zooms }: Section & { zooms: number }) {
  const { zoom } = edit;
  const setParams = (values: Partial<typeof AUTO_ZOOM>) =>
    change((current) =>
      current.zoom.mode === "auto"
        ? { ...current, zoom: { ...current.zoom, params: { ...current.zoom.params, ...values } } }
        : current,
    );
  const setMode = (mode: TakeEdit["zoom"]["mode"]) =>
    change((current) => {
      if (mode === "off") return { ...current, zoom: { mode: "off" } };
      if (mode === "auto")
        return {
          ...current,
          zoom: { mode: "auto", params: current.zoom.mode === "auto" ? current.zoom.params : AUTO_ZOOM },
        };
      return current;
    });
  return (
    <Group title="Zoom">
      <Select
        label="Mode"
        value={zoom.mode}
        options={zoom.mode === "manual" ? ["auto", "manual", "off"] : ["auto", "off"]}
        onChange={setMode}
      />
      {zoom.mode === "auto" && (
        <>
          <Slider
            label="Strength"
            value={zoom.params.maxScale}
            min={1}
            max={4}
            step={0.1}
            format={times}
            onChange={(maxScale) => setParams({ maxScale, minScale: Math.min(zoom.params.minScale, maxScale) })}
          />
          <Slider
            label="Hold after action"
            value={zoom.params.holdMs}
            min={300}
            max={4000}
            step={100}
            format={(ms) => `${(ms / 1000).toFixed(1)}s`}
            onChange={(holdMs) => setParams({ holdMs })}
          />
          <p className="hint">
            {zooms
              ? `${zooms} zoom${zooms === 1 ? "" : "s"} from your clicks and typing`
              : "No clicks or typing in this take, so there is nothing to zoom to."}
          </p>
        </>
      )}
      {zoom.mode === "manual" && <p className="hint">Zoom keyframes are hand-written in the take's edit.json.</p>}
    </Group>
  );
}

function CursorControls({ edit, change }: Section) {
  const update = set(change, "cursor");
  return (
    <Group title="Cursor">
      <Check label="Show cursor" value={edit.cursor.visible} onChange={(visible) => update({ visible })} />
      <Slider
        label="Size"
        value={edit.cursor.size}
        min={0.5}
        max={4}
        step={0.1}
        format={times}
        onChange={(size) => update({ size })}
      />
      <Slider
        label="Smoothing"
        value={edit.cursor.smoothing}
        min={0}
        max={1}
        step={0.05}
        format={percent}
        onChange={(smoothing) => update({ smoothing })}
      />
      <Check
        label="Click ripple"
        value={edit.cursor.clickEffect === "ripple"}
        onChange={(on) => update({ clickEffect: on ? "ripple" : "none" })}
      />
    </Group>
  );
}

function CameraControls({ edit, change }: Section) {
  const update = set(change, "cam");
  return (
    <Group title="Camera">
      <Check label="Show camera" value={edit.cam.visible} onChange={(visible) => update({ visible })} />
      <Select
        label="Shape"
        value={edit.cam.shape}
        options={["circle", "rounded"]}
        onChange={(shape) => update({ shape })}
      />
      <Select
        label="Corner"
        value={edit.cam.corner}
        options={["br", "bl", "tr", "tl"]}
        names={CORNERS}
        onChange={(corner) => update({ corner })}
      />
      <Slider
        label="Size"
        value={edit.cam.size}
        min={0.08}
        max={0.5}
        step={0.01}
        format={percent}
        onChange={(size) => update({ size })}
      />
      <Check label="Mirror" value={edit.cam.mirror} onChange={(mirror) => update({ mirror })} />
    </Group>
  );
}

function FrameControls({ edit, change }: Section) {
  const update = set(change, "canvas");
  const { canvas } = edit;
  const preset = CANVASES.find((size) => size.width === canvas.width && size.height === canvas.height);
  const background = /^#[0-9a-f]{6}$/i.test(canvas.background) ? canvas.background : "#0b0b0f";
  return (
    <Group title="Frame">
      <Select
        label="Shape"
        value={preset?.label ?? "custom"}
        options={[...CANVASES.map((size) => size.label), ...(preset ? [] : ["custom"])]}
        onChange={(label) => {
          const size = CANVASES.find((candidate) => candidate.label === label);
          if (size) update({ width: size.width, height: size.height });
        }}
      />
      <label className="field">
        <span>Background</span>
        <input
          type="color"
          value={background}
          onChange={(event) => update({ background: event.currentTarget.value })}
        />
      </label>
      <Slider
        label="Padding"
        value={canvas.padding}
        min={0}
        max={0.3}
        step={0.01}
        format={percent}
        onChange={(padding) => update({ padding })}
      />
      <Slider
        label="Corner radius"
        value={canvas.radius}
        min={0}
        max={80}
        step={1}
        format={(px) => `${px}px`}
        onChange={(radius) => update({ radius })}
      />
      <Slider
        label="Shadow"
        value={canvas.shadow}
        min={0}
        max={1}
        step={0.05}
        format={percent}
        onChange={(shadow) => update({ shadow })}
      />
    </Group>
  );
}

const MODES = { blur: "Blur", block: "Block" };
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const describeEntry = (entry: RedactEntry) =>
  "sel" in entry
    ? entry.sel
    : `Box ${entry.rect.map(Math.round).join(", ")}, ${seconds(entry.fromMs)}–${seconds(entry.toMs)}`;

function RedactionControls({ edit, change }: Section) {
  const setMode = (index: number, mode: RedactEntry["mode"]) =>
    change((current) => ({
      ...current,
      redact: current.redact.map((entry, at) => (at === index ? { ...entry, mode } : entry)),
    }));
  return (
    <Group title="Redaction">
      {edit.redact.map((entry, index) => (
        <Select
          // biome-ignore lint/suspicious/noArrayIndexKey: entries have no id, and the list never reorders
          key={index}
          label={describeEntry(entry)}
          value={entry.mode}
          options={["blur", "block"]}
          names={MODES}
          onChange={(mode) => setMode(index, mode)}
        />
      ))}
      {!edit.redact.length && (
        <p className="hint">Nothing is hidden. List selectors under redact in clipmunk.config.json before recording.</p>
      )}
    </Group>
  );
}

function VoiceControls({ edit, change }: Section) {
  const update = set(change, "audio");
  return (
    <Group title="Voice">
      <Check label="Mute" value={edit.audio.muted} onChange={(muted) => update({ muted })} />
      <Slider
        label="Volume"
        value={edit.audio.gain}
        min={0}
        max={2}
        step={0.05}
        format={percent}
        onChange={(gain) => update({ gain })}
      />
      <Check
        label="Even out loudness on export"
        value={edit.audio.normalize}
        onChange={(normalize) => update({ normalize })}
      />
    </Group>
  );
}

export function TakeControls({
  take,
  change,
  zooms,
  moments,
}: {
  take: Take;
  change: Change;
  zooms: number;
  moments: number;
}) {
  const { edit, source } = take;
  const section = { edit, change };
  return (
    <aside>
      <ZoomControls {...section} zooms={zooms} />
      <CursorControls {...section} />
      {source.cam && <CameraControls {...section} />}
      <FrameControls {...section} />
      <RedactionControls {...section} />
      <Group title="Music">
        <MusicControls
          value={edit.music}
          hasVoice={!!source.audio}
          clipKey={`take:${take.id}`}
          moments={moments}
          onChange={(music) => change(({ music: _previous, ...rest }) => (music ? { ...rest, music } : rest))}
        />
      </Group>
      {source.audio && <VoiceControls {...section} />}
    </aside>
  );
}
