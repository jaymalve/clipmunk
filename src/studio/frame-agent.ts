import { useEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { CAPTURE_SELECTOR } from "../bridge";
import { formatVariant, parseVariant, type SceneVariant } from "../core";
import type { Clock } from "../react";
import { identify } from "../recorder";

/** The frame page's side of the Studio protocol. The Studio frames the host's frame page and
 * talks to it with postMessage; every message carries `cm: 1`. Messages are accepted only from a
 * loopback origin on the daemon's port, and replies go only there.
 *
 * Studio to frame:
 *  - `seek { t, seq }`: show scene time t. The latest seek wins; stale ones are dropped. Replies
 *    `frame { t, seq }` once that frame is drawn.
 *  - `play { from? }`, `pause`: the frame owns the clock while playing and reports `tick { t }`,
 *    then `stopped { t }`.
 *  - `pick { on }`: outline the element under the pointer; a click replies `picked { el, rect }`,
 *    with `el` as in the event log and `rect` in scene pixels.
 *  - `variant { variant }`: render "theme:dark,locale:de,ratio:9x16".
 *  - `narrate { action: "start" | "stop" | "remove" }`: record narration over the scene in the frame.
 * Frame to Studio: `ready { durationMs, width, height, variant }`, sent when the scene is drawn and
 * again whenever it changes (a hot reload, a new variant), and `narration { phase, hasNarration }`.
 */
export type FrameControls = {
  clock: Clock;
  durationMs: number;
  width: number;
  height: number;
  /** Changes when the scene is reloaded or resized, so `ready` is sent again. */
  version: unknown;
  ready: boolean;
  seek: (timeMs: number) => void;
  play: () => void;
  pause: () => void;
  playing: boolean;
  variant: SceneVariant;
  setVariant: (variant: SceneVariant) => void;
  narration?: {
    start: () => Promise<void> | void;
    stop: () => void;
    remove: () => Promise<void> | void;
    phase: string;
    has: boolean;
  };
};

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** The Studio's origins: loopback on the daemon's port. */
export function studioOrigins(daemonPort: number | undefined): string[] {
  if (!daemonPort) return [];
  return [...LOOPBACK].map((host) => `http://${host}:${daemonPort}`);
}

function postTo(origins: readonly string[], message: Record<string, unknown>) {
  for (const origin of origins) window.parent.postMessage({ cm: 1, ...message }, origin);
}

export function useFrameAgent(enabled: boolean, daemonPort: number | undefined, controls: FrameControls) {
  const latest = useRef(controls);
  latest.current = controls;
  const origins = studioOrigins(daemonPort);
  const allowed = useRef(origins);
  allowed.current = origins;
  const framed = enabled && typeof window !== "undefined" && window.parent !== window;

  // Announce the scene whenever it is (re)drawn.
  const { ready, version, durationMs, width, height } = controls;
  const variantText = formatVariant(controls.variant);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` stands for a reloaded scene
  useEffect(() => {
    if (!framed || !ready) return;
    postTo(allowed.current, { type: "ready", durationMs, width, height, variant: variantText });
  }, [framed, ready, version, durationMs, width, height, variantText, daemonPort]);

  // Ticks while playing, then one `stopped`.
  const { playing, clock } = controls;
  useEffect(() => {
    if (!framed || !playing) return;
    const unsubscribe = clock.subscribe(() => postTo(allowed.current, { type: "tick", t: clock.get() }));
    return () => {
      unsubscribe();
      postTo(allowed.current, { type: "stopped", t: clock.get() });
    };
  }, [framed, playing, clock]);

  const narrationPhase = controls.narration?.phase;
  const hasNarration = controls.narration?.has;
  useEffect(() => {
    if (framed && narrationPhase !== undefined)
      postTo(allowed.current, { type: "narration", phase: narrationPhase, hasNarration });
  }, [framed, narrationPhase, hasNarration]);

  useEffect(() => {
    if (!framed) return;
    let pending: { t: number; seq: unknown } | undefined;
    let busy = false;
    const drain = async () => {
      if (busy) return;
      busy = true;
      while (pending) {
        const { t, seq } = pending;
        pending = undefined;
        flushSync(() => latest.current.seek(t));
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
        if (!pending) postTo(allowed.current, { type: "frame", t: latest.current.clock.get(), seq });
      }
      busy = false;
    };

    let picking = false;
    const outline = document.createElement("div");
    outline.setAttribute("data-clipmunk-chrome", "picker");
    outline.style.cssText =
      "position:fixed;pointer-events:none;border:2px dashed #f5a623;z-index:2147483647;display:none;box-sizing:border-box";
    document.documentElement.append(outline);
    const inScene = (target: EventTarget | null): target is Element =>
      target instanceof Element && !!target.closest(CAPTURE_SELECTOR) && !target.matches(CAPTURE_SELECTOR);
    const hover = (event: PointerEvent) => {
      if (!picking) return;
      if (!inScene(event.target)) {
        outline.style.display = "none";
        return;
      }
      const box = event.target.getBoundingClientRect();
      Object.assign(outline.style, {
        display: "block",
        left: `${box.left}px`,
        top: `${box.top}px`,
        width: `${box.width}px`,
        height: `${box.height}px`,
      });
    };
    const click = (event: MouseEvent) => {
      if (!picking) return;
      event.preventDefault();
      event.stopPropagation();
      if (!inScene(event.target)) return;
      const capture = document.querySelector(CAPTURE_SELECTOR)!.getBoundingClientRect();
      const box = event.target.getBoundingClientRect();
      const scale = capture.width / latest.current.width;
      const round = (value: number) => Math.round(value * 10) / 10;
      postTo(allowed.current, {
        type: "picked",
        el: identify(event.target),
        rect: [
          round((box.left - capture.left) / scale),
          round((box.top - capture.top) / scale),
          round(box.width / scale),
          round(box.height / scale),
        ],
      });
    };
    addEventListener("pointermove", hover, true);
    addEventListener("click", click, true);

    const receive = (event: MessageEvent) => {
      if (!allowed.current.includes(event.origin) || event.source !== window.parent) return;
      const message = event.data as { cm?: number; type?: string; [key: string]: unknown } | null;
      if (!message || message.cm !== 1) return;
      const controls = latest.current;
      switch (message.type) {
        case "seek":
          if (typeof message.t !== "number" || !Number.isFinite(message.t)) return;
          pending = { t: message.t, seq: message.seq };
          void drain();
          return;
        case "play":
          if (typeof message.from === "number" && Number.isFinite(message.from)) controls.seek(message.from);
          controls.play();
          return;
        case "pause":
          controls.pause();
          return;
        case "pick":
          picking = !!message.on;
          outline.style.display = "none";
          return;
        case "variant":
          controls.setVariant(parseVariant(typeof message.variant === "string" ? message.variant : ""));
          return;
        case "narrate":
          if (message.action === "start") void controls.narration?.start();
          if (message.action === "stop") controls.narration?.stop();
          if (message.action === "remove") void controls.narration?.remove();
          return;
      }
    };
    addEventListener("message", receive);
    return () => {
      removeEventListener("message", receive);
      removeEventListener("pointermove", hover, true);
      removeEventListener("click", click, true);
      outline.remove();
    };
  }, [framed]);
}
