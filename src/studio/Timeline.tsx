import { type PointerEvent, useSyncExternalStore } from "react";
import type { Take } from "../core";
import type { Clock } from "../react";

/** Only these small components re-render on every frame of playback. */
export function Time({ clock, durationMs }: { clock: Clock; durationMs: number }) {
  const timeMs = useSyncExternalStore(clock.subscribe, clock.get, clock.get);
  return (
    <span className="time">
      {(timeMs / 1000).toFixed(2)}s / {(durationMs / 1000).toFixed(2)}s
    </span>
  );
}

/** The whole recording left to right: the kept part, where it zooms, and the playhead. Click or drag to seek. */
export function Timeline(props: {
  clock: Clock;
  take: Take;
  segments: { startMs: number; endMs: number }[];
  onSeek: (clipMs: number) => void;
}) {
  const { clock, take, onSeek } = props;
  const timeMs = useSyncExternalStore(clock.subscribe, clock.get, clock.get);
  const total = Math.max(1, take.source.durationMs);
  const { startMs, endMs } = take.edit.trim;
  const percent = (ms: number) => `${(Math.max(0, Math.min(total, ms)) / total) * 100}%`;
  const seekTo = (event: PointerEvent<HTMLDivElement>) => {
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
      {props.segments.map((segment) => (
        <div
          key={segment.startMs}
          className="zoom"
          title="Zoom"
          style={{ left: percent(segment.startMs), width: percent(segment.endMs - segment.startMs) }}
        />
      ))}
      <div className="playhead" style={{ left: percent(startMs + timeMs) }} />
    </div>
  );
}
