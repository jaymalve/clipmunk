import { type PointerEvent, useSyncExternalStore } from "react";
import type { Take, TimeMap } from "../core";
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

/** The whole recording left to right, on the take clock: the kept part, where it plays fast, where it
 * zooms, and the playhead. Click or drag to seek.
 */
export function Timeline(props: {
  clock: Clock;
  take: Take;
  timeMap: TimeMap;
  segments: { startMs: number; endMs: number }[];
  onSeek: (clipMs: number) => void;
}) {
  const { clock, take, timeMap, onSeek } = props;
  const timeMs = useSyncExternalStore(clock.subscribe, clock.get, clock.get);
  const total = Math.max(1, take.source.durationMs);
  const { startMs, endMs } = take.edit.trim;
  const percent = (ms: number) => `${(Math.max(0, Math.min(total, ms)) / total) * 100}%`;
  const seekTo = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    onSeek(timeMap.toClip(((event.clientX - box.left) / box.width) * total));
  };
  return (
    <div
      className="timeline"
      role="slider"
      aria-label="Take time"
      aria-valuemin={0}
      aria-valuemax={Math.round(timeMap.durationMs)}
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
      {timeMap.segments
        .filter((segment) => segment.speed !== 1)
        .map((segment) => (
          <div
            key={`fast-${segment.fromMs}`}
            className="fast"
            title={`${segment.speed}× faster`}
            style={{ left: percent(segment.fromMs), width: percent(segment.toMs - segment.fromMs) }}
          />
        ))}
      {props.segments.map((segment) => (
        <div
          key={segment.startMs}
          className="zoom"
          title="Zoom"
          style={{ left: percent(segment.startMs), width: percent(segment.endMs - segment.startMs) }}
        />
      ))}
      <div className="playhead" style={{ left: percent(timeMap.toTake(timeMs)) }} />
    </div>
  );
}
