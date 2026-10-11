import type { TakeEvent } from "../core";

/** Logs what the pointer and keyboard do during a recording, on the take clock.
 * The log drives the synthetic cursor and auto-zoom later. It records where things
 * happened, never what was typed or what any element contains.
 */
export type EventLogOptions = {
  /** Milliseconds on the take clock. */
  clock: () => number;
  /** Receives newline-terminated JSON lines, about once a second. */
  flush: (lines: string) => void;
  /** The cursor the page wants at this element, read with the recorder's cursor override lifted. */
  cursorOf: (element: Element) => string;
  /** Elements inside this host (the HUD) are not part of the recording. */
  ignore: (event: Event) => boolean;
};

const EDITABLE =
  'input:not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]), textarea, [contenteditable=""], [contenteditable="true"]';
const INTERACTIVE =
  'button, a[href], input, textarea, select, label, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], [role="checkbox"], [role="switch"], [contenteditable]';
const round = (value: number) => Math.round(value * 10) / 10;
const rectOf = (element: Element): [number, number, number, number] => {
  const box = element.getBoundingClientRect();
  return [round(box.left), round(box.top), round(box.width), round(box.height)];
};

export function createEventLog(options: EventLogOptions) {
  let buffer: string[] = [];
  let pendingMove: { x: number; y: number } | undefined;
  let pendingScroll = false;
  let frame = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let cursor: "default" | "pointer" | "text" = "default";
  const push = (event: TakeEvent) => buffer.push(JSON.stringify(event));
  const now = () => Math.max(0, Math.round(options.clock()));
  const flush = () => {
    if (!buffer.length) return;
    options.flush(`${buffer.join("\n")}\n`);
    buffer = [];
  };
  // Pointer and scroll events fire far more often than frames are drawn; keep one per frame.
  const drain = () => {
    frame = 0;
    if (pendingMove) push({ t: now(), k: "move", x: round(pendingMove.x), y: round(pendingMove.y) });
    if (pendingScroll) push({ t: now(), k: "scroll", x: round(scrollX), y: round(scrollY) });
    pendingMove = undefined;
    pendingScroll = false;
  };
  const schedule = () => (frame ||= requestAnimationFrame(drain));

  const handlers: [string, (event: any) => void][] = [
    [
      "pointermove",
      (event: PointerEvent) => {
        pendingMove = { x: event.clientX, y: event.clientY };
        schedule();
      },
    ],
    [
      "pointerover",
      (event: PointerEvent) => {
        if (!(event.target instanceof Element)) return;
        const wanted = options.cursorOf(event.target);
        const style =
          wanted === "pointer" ? "pointer" : wanted === "text" || wanted === "vertical-text" ? "text" : "default";
        if (style !== cursor) push({ t: now(), k: "cursor", style: (cursor = style) });
      },
    ],
    [
      "pointerdown",
      (event: PointerEvent) => {
        if (frame) cancelAnimationFrame(frame), drain(); // the click must come after the move that led to it
        const target =
          event.target instanceof Element ? (event.target.closest(INTERACTIVE) ?? event.target) : document.body;
        push({
          t: now(),
          k: "down",
          x: round(event.clientX),
          y: round(event.clientY),
          button: event.button,
          rect: rectOf(target),
        });
      },
    ],
    [
      "pointerup",
      (event: PointerEvent) =>
        push({ t: now(), k: "up", x: round(event.clientX), y: round(event.clientY), button: event.button }),
    ],
    [
      "scroll",
      () => {
        pendingScroll = true;
        schedule();
      },
    ],
    [
      "focusin",
      (event: FocusEvent) => {
        if (event.target instanceof Element)
          push({ t: now(), k: "focus", rect: rectOf(event.target), editable: event.target.matches(EDITABLE) });
      },
    ],
    [
      "keydown",
      (event: KeyboardEvent) => {
        // Only that typing happened and where. The key itself is deliberately not read.
        if (
          event.target instanceof Element &&
          event.target.matches(EDITABLE) &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey
        )
          push({ t: now(), k: "type", rect: rectOf(event.target) });
      },
    ],
    ["resize", () => push({ t: now(), k: "resize", width: innerWidth, height: innerHeight })],
  ];
  const listeners = handlers.map(
    ([type, handler]) => [type, (event: Event) => !options.ignore(event) && handler(event)] as const,
  );

  return {
    start() {
      push({ t: 0, k: "resize", width: innerWidth, height: innerHeight });
      for (const [type, listener] of listeners) addEventListener(type, listener, { capture: true, passive: true });
      timer = setInterval(flush, 1000);
    },
    stop() {
      for (const [type, listener] of listeners) removeEventListener(type, listener, { capture: true });
      if (frame) cancelAnimationFrame(frame), drain();
      clearInterval(timer);
      flush();
    },
  };
}
