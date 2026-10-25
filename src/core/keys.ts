import type { TakeEvent } from "./take";

/** Keyboard shortcuts shown as pills, from the log's `combo` events. The recorder logs a combo
 * only when Meta, Control or Alt is held, and never in a password field, so plain typing
 * never becomes a pill.
 */
export type KeyPill = { atMs: number; keys: string[] };

/** How long a pill shows, and how many show at once (the most recent). */
export const KEY_PILL_MS = 900;
const MAX_PILLS = 3,
  FADE_MS = 150;

const NAMES: Record<string, string> = {
  Meta: "⌘",
  Control: "Ctrl",
  Alt: "⌥",
  Shift: "⇧",
  Enter: "↵",
  Escape: "Esc",
  Backspace: "⌫",
  Delete: "Del",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  " ": "Space",
};
/** A key as it is printed on a pill: symbols for modifiers and arrows, letters in capitals. */
export const keyLabel = (key: string) => NAMES[key] ?? (key.length === 1 ? key.toUpperCase() : key);

export const keyPills = (events: readonly TakeEvent[]): KeyPill[] =>
  events
    .flatMap((event) => (event.k === "combo" ? [{ atMs: event.t, keys: event.keys.map(keyLabel) }] : []))
    .sort((a, b) => a.atMs - b.atMs);

/** The pills showing at a time, oldest first, each with its opacity. */
export function pillsAt(pills: readonly KeyPill[], timeMs: number): (KeyPill & { opacity: number })[] {
  const showing = pills.filter((pill) => timeMs >= pill.atMs && timeMs < pill.atMs + KEY_PILL_MS);
  return showing.slice(-MAX_PILLS).map((pill) => {
    const age = timeMs - pill.atMs;
    return { ...pill, opacity: Math.min(1, (KEY_PILL_MS - age) / FADE_MS) };
  });
}
