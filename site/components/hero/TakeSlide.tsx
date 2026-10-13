"use client";

import { type CSSProperties, useEffect, useRef, useState } from "react";
import { PullRequest, type PullRequestState } from "@/demo/PullRequest";
import type { SlideProps } from "./slide";
import { FRAME, prefersStillness, useFit } from "./useFit";

type Target = "files" | "diff" | "approve" | "merge";
type Point = { x: number; y: number };
type Zoom = { scale: number; x: number; y: number };

const START: PullRequestState = { tab: "conversation", approved: false, merged: false };
const REST: Zoom = { scale: 1, x: 0, y: 0 };
const WAITING: Point = { x: 980, y: 720 };
const LENGTH_MS = 10200;

/** The move that puts `point` in the middle of the frame at `scale`, without showing past the frame's edges. */
function zoomOn(point: Point, scale: number): Zoom {
  const within = (value: number, room: number) => Math.min(0, Math.max(room * (1 - scale), value));
  return {
    scale,
    x: within(FRAME.width / 2 - point.x * scale, FRAME.width),
    y: within(FRAME.height / 2 - point.y * scale, FRAME.height),
  };
}

/**
 * A recording of someone reviewing and merging a pull request, as Clipmunk would finish it:
 * the cursor glides, every click gets a ripple, and the frame closes in on what was clicked.
 */
export default function TakeSlide({ onProgress, onDone }: SlideProps) {
  const box = useRef<HTMLDivElement>(null);
  const page = useRef<HTMLDivElement>(null);
  const fit = useFit(box);
  const [state, setState] = useState(START);
  const [cursor, setCursor] = useState(WAITING);
  const [zoom, setZoom] = useState(REST);
  const [click, setClick] = useState<{ at: Point; id: number } | null>(null);
  const [run, setRun] = useState(0);

  const report = useRef({ onProgress, onDone });
  report.current = { onProgress, onDone };

  useEffect(() => {
    setState(START);
    setCursor(WAITING);
    setZoom(REST);
    setClick(null);
    if (prefersStillness()) return;

    /** Where a marked element is on the page, in the frame's own pixels, whatever the zoom is right now. */
    const find = (target: Target): Point | null => {
      const frame = page.current;
      const el = frame?.querySelector<HTMLElement>(`[data-take="${target}"]`);
      if (!frame || !el) return null;
      const outer = frame.getBoundingClientRect(),
        inner = el.getBoundingClientRect();
      const ratio = FRAME.width / outer.width;
      return {
        x: (inner.left + inner.width / 2 - outer.left) * ratio,
        y: (inner.top + inner.height / 2 - outer.top) * ratio,
      };
    };
    const goTo = (target: Target) => {
      const point = find(target);
      if (point) setCursor(point);
    };
    const press = (target: Target, after: () => void) => {
      const point = find(target);
      if (point) setClick({ at: point, id: performance.now() });
      after();
    };
    const closeIn = (target: Target, scale: number) => {
      // Wait a frame so the page has drawn whatever the click changed.
      requestAnimationFrame(() => {
        const point = find(target);
        if (point) setZoom(zoomOn(point, scale));
      });
    };

    const script: [number, () => void][] = [
      [700, () => goTo("files")],
      [1700, () => press("files", () => setState({ ...START, tab: "files" }))],
      [1900, () => closeIn("diff", 1.3)],
      [3900, () => goTo("approve")],
      [4900, () => press("approve", () => setState({ tab: "files", approved: true, merged: false }))],
      [5100, () => closeIn("merge", 1.55)],
      [5900, () => goTo("merge")],
      [6900, () => press("merge", () => setState({ tab: "files", approved: true, merged: true }))],
      [8400, () => setZoom(REST)],
    ];
    const timers = script.map(([at, step]) => window.setTimeout(step, at));

    const started = performance.now();
    let raf = requestAnimationFrame(function tick(now) {
      const elapsed = now - started;
      report.current.onProgress(Math.min(1, elapsed / LENGTH_MS));
      if (elapsed >= LENGTH_MS) {
        report.current.onDone();
        setRun((count) => count + 1);
        return;
      }
      raf = requestAnimationFrame(tick);
    });
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
      cancelAnimationFrame(raf);
    };
  }, [run]);

  return (
    <div ref={box} className="slide slide--take">
      {fit > 0 && (
        <div className="slide__frame" style={{ transform: `scale(${fit})` }}>
          <div
            ref={page}
            className="take-page"
            style={{ transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})` }}
          >
            <PullRequest {...state} />
            {click && <span key={click.id} className="take-ripple" style={{ left: click.at.x, top: click.at.y }} />}
            <svg
              className="take-cursor"
              viewBox="0 0 20 22"
              aria-hidden="true"
              style={{ "--x": `${cursor.x}px`, "--y": `${cursor.y}px` } as CSSProperties}
            >
              <path d="M2 1.5v16l4.4-3.9 2.9 6.6 2.7-1.2-2.9-6.5h6.1z" />
            </svg>
          </div>
        </div>
      )}
      <p className="slide__note mono">A screen recording, enhanced: smooth cursor, click ripples, auto-zoom.</p>
    </div>
  );
}
