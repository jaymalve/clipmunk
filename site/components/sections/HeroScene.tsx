"use client";

import { useEffect, useRef, useState } from "react";
import Chip from "@/components/chip/Chip";

type Phase = "idle" | "slate" | "rolling" | "saved";
type Layer = "chart" | "plans" | "publish";

/** How far each part of the mock app sits from the glass, in pixels. */
const DEPTH: Record<Layer, number> = { chart: 8, plans: 44, publish: 84 };

const IDLE_LINES = ["Sniffing the UI…", "Found a good angle."];
/** How long the scene rests between takes. */
const REST_MS = 3200;
/** When the last piece of the app has landed and the tilt starts to level out, and how long levelling takes. */
const SETTLE_AT_MS = 3300;
const SETTLE_MS = 1700;
const TAKE_MS = 5000;
const CLICK_MS = 2300;
const ZOOM_OUT_MS = 4300;

const PLANS = [
  { name: "Starter", price: "$0", note: "1k events" },
  { name: "Team", price: "$29", note: "50k events", hot: true },
  { name: "Scale", price: "$99", note: "1M events" },
];
const BARS = [34, 48, 41, 62, 55, 78, 70, 92];

function blurFor(layer: Layer, focus: Layer) {
  return `blur(${Math.min(3, Math.abs(DEPTH[layer] - DEPTH[focus]) / 30).toFixed(2)}px)`;
}

/**
 * A small stand-in for the product. The mock app arrives tilted, its pieces drop into place, and it
 * levels out to face the visitor. Then a fake take, with a smoothed cursor and one automatic zoom,
 * plays again and again.
 */
export default function HeroScene() {
  const timers = useRef<number[]>([]);
  const zoom = useRef<HTMLDivElement>(null);
  const publish = useRef<HTMLSpanElement>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [focus, setFocus] = useState<Layer>("plans");
  const [zoomed, setZoomed] = useState(false);
  const [clicked, setClicked] = useState(false);
  // Tilted, then levelling, then level and ready to record.
  const [settled, setSettled] = useState(false);
  const [ready, setReady] = useState(false);
  const [line, setLine] = useState(0);
  const [takes, setTakes] = useState(41);

  const busy = phase !== "idle";

  useEffect(() => {
    if (busy) return;
    const timer = window.setInterval(() => setLine((index) => (index + 1) % IDLE_LINES.length), 3400);
    return () => window.clearInterval(timer);
  }, [busy]);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setSettled(true);
      return;
    }
    const level = window.setTimeout(() => setSettled(true), SETTLE_AT_MS);
    const start = window.setTimeout(() => setReady(true), SETTLE_AT_MS + SETTLE_MS);
    return () => {
      window.clearTimeout(level);
      window.clearTimeout(start);
    };
  }, []);

  function later(ms: number, run: () => void) {
    timers.current.push(window.setTimeout(run, ms));
  }

  // The cursor, its ripple and the zoom all aim at the middle of the Publish button, wherever the layout put it.
  function aim() {
    const button = publish.current;
    const frame = zoom.current;
    if (!button || !frame) return;
    // Layout offsets, summed up to the zooming frame, so the tilt and the zoom do not skew the answer.
    let x = button.offsetWidth / 2;
    let y = button.offsetHeight / 2;
    for (
      let node: HTMLElement | null = button;
      node && node !== frame;
      node = node.offsetParent as HTMLElement | null
    ) {
      x += node.offsetLeft;
      y += node.offsetTop;
    }
    frame.style.setProperty("--hit-x", `${x}px`);
    frame.style.setProperty("--hit-y", `${y}px`);
  }

  function roll() {
    if (busy) return;
    aim();
    setTakes((count) => count + 1);
    setClicked(false);
    setPhase("slate");
    later(600, () => setPhase("rolling"));
    later(600 + CLICK_MS, () => {
      setClicked(true);
      setZoomed(true);
      setFocus("publish");
    });
    later(600 + ZOOM_OUT_MS, () => setZoomed(false));
    later(600 + TAKE_MS, () => setPhase("saved"));
    later(600 + TAKE_MS + 3600, () => {
      setPhase("idle");
      setFocus("plans");
      setClicked(false);
    });
  }

  // The latest roll, so the loop below never holds a stale one.
  const rollRef = useRef(roll);
  rollRef.current = roll;

  // Once the app is level: take after take, with a rest in between.
  // Visitors who asked for less motion never become ready, so they keep the still scene.
  useEffect(() => {
    if (!ready || phase !== "idle") return;
    const timer = window.setTimeout(() => rollRef.current(), REST_MS);
    return () => window.clearTimeout(timer);
  }, [ready, phase]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending) window.clearTimeout(timer);
    };
  }, []);

  function layer(name: Layer) {
    return {
      style: { transform: `translateZ(${DEPTH[name]}px)`, filter: blurFor(name, focus) },
      onPointerEnter: () => {
        if (!busy) setFocus(name);
      },
    };
  }

  const said =
    phase === "slate"
      ? `Take ${takes}. Rolling.`
      : phase === "rolling"
        ? clicked
          ? "Ooh. Zooming in on that."
          : "Smoothing your cursor…"
        : phase === "saved"
          ? "Cut. That's the one."
          : IDLE_LINES[line];

  return (
    <div className={`scene ${settled ? "is-settled" : ""}`} data-phase={phase}>
      <div className="scene__stage">
        <div className="scene__tilt">
          <div ref={zoom} className={`scene__zoom ${zoomed ? "is-zoomed" : ""}`}>
            <div className="app">
              <div className="win__bar">
                <span className="win__dots">
                  <i />
                  <i />
                  <i />
                </span>
                localhost:5173/billing
              </div>
              <div className="app__body">
                <ul className="app__side">
                  <li>Overview</li>
                  <li className="is-on">Billing</li>
                  <li>Usage</li>
                  <li>Team</li>
                </ul>
                <div className="app__main">
                  <div className="app__head">
                    <div>
                      <p className="app__title">Usage-based plans</p>
                      <p className="app__sub">Draft · edited just now</p>
                    </div>
                    <span ref={publish} className={`app__publish ${clicked ? "is-done" : ""}`} {...layer("publish")}>
                      {clicked ? "Published ✓" : "Publish"}
                    </span>
                  </div>
                  <div className="app__plans" {...layer("plans")}>
                    {PLANS.map((plan) => (
                      <div key={plan.name} className={`app__plan ${plan.hot ? "is-hot" : ""}`}>
                        <span>{plan.name}</span>
                        <b>{plan.price}</b>
                        <i>{plan.note}</i>
                      </div>
                    ))}
                  </div>
                  <div className="app__chart" {...layer("chart")}>
                    <span>Events / day</span>
                    <div className="app__bars">
                      {BARS.map((height, index) => (
                        <i key={height} style={{ height: `${height}%`, animationDelay: `${2.4 + index * 0.12}s` }} />
                      ))}
                    </div>
                  </div>
                </div>
              </div>
              <span className="scene__ripple" />
              <svg className="scene__cursor" viewBox="0 0 20 22" aria-hidden>
                <path d="M2 1.5v16l4.4-3.9 2.9 6.6 2.7-1.2-2.9-6.5h6.1z" />
              </svg>
            </div>
          </div>
        </div>
      </div>

      <div className="scene__chip">
        <p className="scene__say" key={said}>
          {said}
        </p>
        <Chip
          prop="clapper"
          eye={phase === "saved" ? "happy" : phase === "rolling" ? "wide" : "open"}
          className={phase === "slate" || phase === "rolling" ? "is-clapped" : ""}
        />
      </div>
    </div>
  );
}
