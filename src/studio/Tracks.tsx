import { type PointerEvent, type ReactNode, useSyncExternalStore } from "react";
import type { Caption, Take, TakeEvent, TimeMap } from "../core";
import type { Clock } from "../react";

/** The editor's timeline: one track per part of the take, all on the recording's own clock. The
 * take track shows the kept range (drag its ends to trim) and the parts pacing speeds up; below it,
 * the clicks, the zooms, the captions, the redacted elements and the music's accents. Click a
 * segment to inspect it, or anywhere else to move the playhead.
 */
export type Selection = { kind: "zoom"; index: number } | { kind: "caption"; atMs: number } | { kind: "redact" };

export function Tracks(props: {
  clock: Clock;
  take: Take;
  events: readonly TakeEvent[];
  timeMap: TimeMap;
  zooms: { startMs: number; endMs: number }[];
  captions: Caption[];
  /** Clip times of the music's accents, when the take has music. */
  accents: number[];
  selection?: Selection;
  onSelect: (selection: Selection | undefined) => void;
  onSeek: (clipMs: number) => void;
  onTrim: (startMs: number, endMs: number) => void;
}) {
  const { clock, take, timeMap } = props;
  const timeMs = useSyncExternalStore(clock.subscribe, clock.get, clock.get);
  const total = Math.max(1, take.source.durationMs);
  const { startMs, endMs } = take.edit.trim;
  const left = (ms: number) => `${(Math.max(0, Math.min(total, ms)) / total) * 100}%`;
  const width = (from: number, to: number) =>
    `${(Math.max(0, Math.min(total, to) - Math.max(0, from)) / total) * 100}%`;
  /** Take time under the pointer in a lane (every lane spans the whole recording). */
  const takeTimeAt = (clientX: number, lane: Element) => {
    const area = lane.getBoundingClientRect();
    return Math.max(0, Math.min(total, ((clientX - area.left) / area.width) * total));
  };
  const seek = (event: PointerEvent) => props.onSeek(timeMap.toClip(takeTimeAt(event.clientX, event.currentTarget)));
  const drag = (event: PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move = (end: "start" | "end") => (event: PointerEvent<HTMLButtonElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const at = takeTimeAt(event.clientX, event.currentTarget.parentElement!);
    if (end === "start") props.onTrim(Math.min(at, endMs - 100), endMs);
    else props.onTrim(startMs, Math.max(at, startMs + 100));
  };

  const clicks = props.events.filter((event) => event.k === "down");
  // A selector's redaction runs from its first box to the last time it had one.
  const redactions = take.edit.redact.flatMap((entry) => {
    if ("rect" in entry) return [{ from: entry.fromMs, to: entry.toMs, label: "box" }];
    const boxes = props.events.filter((event) => event.k === "redact" && event.sel === entry.sel);
    if (!boxes.length) return [];
    const last = boxes.at(-1)!;
    const to = last.k === "redact" && last.rects.length ? total : last.t;
    return [{ from: boxes[0]!.t, to, label: entry.sel }];
  });
  const selected = props.selection;

  return (
    <div className="tracks">
      <Row label="Take" onPointerDown={seek}>
        <div className="kept" style={{ left: left(startMs), width: width(startMs, endMs) }} />
        {timeMap.segments
          .filter((segment) => segment.speed !== 1)
          .map((segment) => (
            <div
              key={`fast-${segment.fromMs}`}
              className="fast"
              title={`${segment.speed}× faster`}
              style={{ left: left(segment.fromMs), width: width(segment.fromMs, segment.toMs) }}
            />
          ))}
        <button
          type="button"
          className="handle"
          aria-label="Trim start"
          style={{ left: left(startMs) }}
          onPointerDown={drag}
          onPointerMove={move("start")}
        />
        <button
          type="button"
          className="handle"
          aria-label="Trim end"
          style={{ left: left(endMs) }}
          onPointerDown={drag}
          onPointerMove={move("end")}
        />
      </Row>
      <Row label="Clicks" onPointerDown={seek}>
        {clicks.map((click) => (
          <i key={click.t} className="dot" style={{ left: left(click.t) }} />
        ))}
      </Row>
      <Row label="Zoom" onPointerDown={seek}>
        {props.zooms.map((zoom, index) => (
          <button
            key={zoom.startMs}
            type="button"
            className={`segment zoom${selected?.kind === "zoom" && selected.index === index ? " on" : ""}`}
            aria-label={`Zoom ${index + 1}`}
            style={{ left: left(zoom.startMs), width: width(zoom.startMs, zoom.endMs) }}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => props.onSelect({ kind: "zoom", index })}
          />
        ))}
      </Row>
      <Row label="Captions" onPointerDown={seek}>
        {props.captions.map((caption) => (
          <button
            key={caption.atMs}
            type="button"
            className={`segment caption${selected?.kind === "caption" && selected.atMs === caption.atMs ? " on" : ""}`}
            aria-label={`Caption ${caption.text || "(hidden)"}`}
            style={{ left: left(caption.atMs), width: width(caption.atMs, caption.atMs + caption.durMs) }}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => props.onSelect({ kind: "caption", atMs: caption.atMs })}
          >
            {caption.text}
          </button>
        ))}
      </Row>
      <Row label="Redaction" onPointerDown={seek}>
        {redactions.map((span) => (
          <button
            key={`${span.label}-${span.from}`}
            type="button"
            className={`segment redact${selected?.kind === "redact" ? " on" : ""}`}
            aria-label={`Redaction ${span.label}`}
            style={{ left: left(span.from), width: width(span.from, span.to) }}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => props.onSelect({ kind: "redact" })}
          />
        ))}
      </Row>
      {take.edit.music && (
        <Row label="Music" onPointerDown={seek}>
          {props.accents.map((accent) => (
            <i key={accent} className="tick" style={{ left: left(timeMap.toTake(accent)) }} />
          ))}
        </Row>
      )}
      <div className="playhead" style={{ left: `calc(84px + (100% - 84px) * ${timeMap.toTake(timeMs) / total})` }} />
    </div>
  );
}

function Row(props: { label: string; children?: ReactNode; onPointerDown: (event: PointerEvent) => void }) {
  return (
    <div className="track">
      <span className="name">{props.label}</span>
      <div className="lane" onPointerDown={props.onPointerDown}>
        {props.children}
      </div>
    </div>
  );
}
