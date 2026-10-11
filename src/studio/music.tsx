import { useEffect, useRef, useState } from "react";
import {
  MUSIC_STYLES,
  type Music,
  type MusicRequest,
  MusicSchema,
  type MusicStyle,
  planMusic,
  renderMusic,
} from "../core";
import type { Clock } from "../react";

/** Generated music in the studio: the controls that choose it, and playback alongside a
 * clip's clock. The sound comes from the same pure function the exporter uses.
 */
const NAMES: Record<MusicStyle, string> = { upbeat: "Upbeat", lofi: "Lo-fi" };
let shared: AudioContext | undefined;
const audio = () => (shared ??= new AudioContext());

function toBuffer(request: MusicRequest): AudioBuffer {
  const context = audio();
  const rendered = renderMusic({ ...request, sampleRate: context.sampleRate });
  const buffer = context.createBuffer(2, rendered.left.length, rendered.sampleRate);
  buffer.copyToChannel(rendered.left as Float32Array<ArrayBuffer>, 0);
  buffer.copyToChannel(rendered.right as Float32Array<ArrayBuffer>, 1);
  return buffer;
}

export type MusicClip = { key: string; durationMs: number; momentsMs?: readonly number[] };

/** Play a clip's music in step with its clock. Ducking under a voice happens at export only. */
export function useMusicPreview(options: { music?: Music; clip: MusicClip; clock: Clock; playing: boolean }) {
  const { music, clock, playing } = options;
  const [buffer, setBuffer] = useState<AudioBuffer>();
  // Only what changes the sound: volume and ducking do not need a new render.
  const plan = music
    ? JSON.stringify(planMusic(music, { ...options.clip, durationMs: Math.round(options.clip.durationMs) }))
    : "";
  useEffect(() => {
    setBuffer(undefined);
    if (!plan) return;
    const request = JSON.parse(plan) as MusicRequest;
    if (request.durationMs <= 0) return;
    // Synthesis takes a moment for a long clip; let the page paint the new setting first.
    const timer = setTimeout(() => setBuffer(toBuffer(request)), 30);
    return () => clearTimeout(timer);
  }, [plan]);

  const volume = useRef<GainNode | undefined>(undefined);
  useEffect(() => {
    if (volume.current && music) volume.current.gain.value = music.gain;
  }, [music?.gain]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!playing || !buffer || !music) return;
    const context = audio();
    void context.resume();
    const source = context.createBufferSource();
    const gain = (volume.current = context.createGain());
    gain.gain.value = music.gain;
    source.buffer = buffer;
    source.connect(gain).connect(context.destination);
    source.start(0, Math.min(buffer.duration, Math.max(0, clock.get() / 1000)));
    return () => {
      source.stop();
      source.disconnect();
      gain.disconnect();
      volume.current = undefined;
    };
  }, [playing, buffer]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Style, volume, a new tune in the same style, and a short listen. `onChange(undefined)` turns music off. */
export function MusicControls({
  value,
  onChange,
  hasVoice,
  clipKey,
  moments = 0,
}: {
  value: Music | undefined;
  onChange: (music: Music | undefined) => void;
  hasVoice?: boolean;
  clipKey: string;
  moments?: number;
}) {
  const [listening, setListening] = useState(false);
  const stop = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => stop.current?.(), []);
  const listen = () => {
    if (!value) return;
    if (stop.current) return stop.current();
    const context = audio();
    void context.resume();
    const source = context.createBufferSource(),
      gain = context.createGain();
    gain.gain.value = value.gain;
    source.buffer = toBuffer(planMusic(value, { key: clipKey, durationMs: 12_000 }));
    source.connect(gain).connect(context.destination);
    source.start();
    setListening(true);
    stop.current = () => {
      stop.current = undefined;
      source.onended = null;
      source.stop();
      source.disconnect();
      setListening(false);
    };
    source.onended = () => stop.current?.();
  };
  const change = (music: Music | undefined) => {
    stop.current?.();
    onChange(music);
  };
  return (
    <>
      <label className="field">
        <span>Music</span>
        <select
          value={value?.style ?? "off"}
          onChange={(event) =>
            change(
              event.currentTarget.value === "off"
                ? undefined
                : MusicSchema.parse({ ...value, style: event.currentTarget.value }),
            )
          }
        >
          <option value="off">Off</option>
          {MUSIC_STYLES.map((style) => (
            <option key={style} value={style}>
              {NAMES[style]}
            </option>
          ))}
        </select>
      </label>
      {value && (
        <>
          <label className="field">
            <span>Volume</span>
            <input
              type="range"
              min={0}
              max={1.5}
              step={0.05}
              value={value.gain}
              onChange={(event) => onChange({ ...value, gain: Number(event.currentTarget.value) })}
            />
            <output>{Math.round(value.gain * 100)}%</output>
          </label>
          {hasVoice && (
            <label className="field check">
              <input
                type="checkbox"
                checked={value.duck}
                onChange={(event) => onChange({ ...value, duck: event.currentTarget.checked })}
              />
              <span>Lower under voice (on export)</span>
            </label>
          )}
          {moments > 0 && (
            <label className="field check">
              <input
                type="checkbox"
                checked={value.sync}
                onChange={(event) => change({ ...value, sync: event.currentTarget.checked })}
              />
              <span>
                Sync the beat to {moments} moment{moments === 1 ? "" : "s"} in this clip
              </span>
            </label>
          )}
          <div className="field tune">
            <button
              type="button"
              onClick={() => change({ ...value, seed: Math.floor(Math.random() * 1_000_000) })}
              title="A different tune in the same style"
            >
              New tune
            </button>
            <button type="button" onClick={listen}>
              {listening ? "Stop" : "Listen"}
            </button>
          </div>
          <p className="hint">Generated by Flick from code, so it is yours to use anywhere.</p>
        </>
      )}
    </>
  );
}
