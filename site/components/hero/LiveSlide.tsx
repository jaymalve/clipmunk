"use client";

import { type PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { type DashboardPart, DashboardScene } from "@/demo/DashboardScene";
import type { SlideProps } from "./slide";
import { FRAME, prefersStillness, useFit } from "./useFit";

type Sdk = typeof import("clipmunk");

const DURATION_MS = 9000;
const PERSPECTIVE = 1400;
const CAMERA = { perspective: PERSPECTIVE, rotateY: -20, rotateX: 7, z: -90 };

/** Where each section rests in depth. The numbers are pixels toward the viewer. */
const REST: Record<DashboardPart, number> = { sidebar: 0, header: 50, stats: 120, chart: 70, customers: 170 };

const NODES = [{ id: "page" }, ...Object.entries(REST).map(([id, z]) => ({ id, parentId: "page", transform: { z } }))];

/** One slow pass of the camera from left to right; the sections never move, only the viewpoint does. */
const MOTION = {
  durationMs: DURATION_MS,
  tracks: [
    {
      target: { kind: "camera" },
      property: "x",
      keyframes: [
        { timeMs: 0, value: -230, easing: "easeInOut" },
        { timeMs: DURATION_MS, value: 190 },
      ],
    },
  ],
};

/** The charts draw during the first third of the pass. */
function Page({ sdk, onPoint }: { sdk: Sdk; onPoint: (part: DashboardPart) => void }) {
  const time = sdk.useSceneTime();
  return <DashboardScene Surface={sdk.Surface} progress={time / 3200} onPoint={onPoint} />;
}

/**
 * The same dashboard as the film, as a real scene running in the browser: Clipmunk's own renderer,
 * loaded only when this slide is shown. Move the pointer to turn the camera; point at a section to focus on it.
 */
export default function LiveSlide({ onProgress, onDone, onTouch }: SlideProps) {
  const box = useRef<HTMLDivElement>(null);
  const scale = useFit(box);
  const [sdk, setSdk] = useState<Sdk | null>(null);
  const [turn, setTurn] = useState({ x: 0, y: 0 });
  const [subject, setSubject] = useState<DashboardPart>("chart");
  const frame = useRef(0);

  useEffect(() => {
    let alive = true;
    import("clipmunk").then((module) => {
      if (alive) setSdk(module);
    });
    return () => {
      alive = false;
    };
  }, []);

  const clock = useMemo(() => sdk?.createClock(prefersStillness() ? 3200 : 0), [sdk]);

  // The latest callbacks, so the loop below can start once and keep running.
  const report = useRef({ onProgress, onDone });
  report.current = { onProgress, onDone };

  useEffect(() => {
    if (!clock || prefersStillness()) return;
    let raf = 0;
    let started = performance.now();
    const tick = (now: number) => {
      let elapsed = now - started;
      if (elapsed >= DURATION_MS) {
        report.current.onDone();
        started = now;
        elapsed = 0;
      }
      clock.set(elapsed);
      report.current.onProgress(elapsed / DURATION_MS);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [clock]);

  function onMove(event: PointerEvent<HTMLDivElement>) {
    const area = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - area.left) / area.width - 0.5;
    const y = (event.clientY - area.top) / area.height - 0.5;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => setTurn({ x, y }));
  }

  const camera = { ...CAMERA, rotateY: CAMERA.rotateY + turn.x * 16, rotateX: CAMERA.rotateX - turn.y * 10 };
  // A point's depth is the perspective minus its distance toward the camera.
  const focus = {
    distance: PERSPECTIVE - (REST[subject] - CAMERA.z),
    fStop: 1.8,
    focalLength: 100,
    maxBlur: scale < 0.4 ? 3 : 6,
  };

  return (
    <div
      ref={box}
      className="slide slide--live"
      onPointerMove={onMove}
      onPointerDown={onTouch}
      onPointerLeave={() => setTurn({ x: 0, y: 0 })}
    >
      {sdk && clock && scale > 0 && (
        <div className="slide__frame" style={{ transform: `scale(${scale})` }}>
          <sdk.Scene
            camera={camera}
            focus={focus}
            nodes={NODES}
            motion={MOTION}
            clock={clock}
            quality="preview"
            style={{ width: FRAME.width, height: FRAME.height }}
          >
            <Page
              sdk={sdk}
              onPoint={(part) => {
                onTouch();
                setSubject(part);
              }}
            />
          </sdk.Scene>
        </div>
      )}
      <p className="slide__note mono">Live in your browser. Point at a section to focus on it.</p>
    </div>
  );
}
