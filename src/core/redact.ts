import type { RedactEntry, RedactMode, TakeEvent } from "./take";

/** Where the hidden areas of a take are at any time. Selector entries follow the log's
 * `redact` events: each event gives every box of its selector, and holds until the next one.
 * A box never shows by a frame: around a change both the old and the new box are covered,
 * and every box is grown a little, so a frame that lags or leads the log stays hidden.
 */
export type Rect = [x: number, y: number, width: number, height: number];
export type RedactBox = { rect: Rect; mode: RedactMode };
export type RedactionTrack = {
  /** Boxes in source CSS pixels to hide at a time on the take clock. */
  at(timeMs: number): RedactBox[];
  /** Whether anything is hidden at all, so renderers can skip the work. */
  readonly empty: boolean;
};

/** How far either side of a change both boxes are covered. */
export const REDACT_GUARD_MS = 150;
/** CSS pixels added on every side of a logged box. */
export const REDACT_MARGIN = 4;

type Change = { t: number; rects: Rect[] };

export function redactionTrack(events: readonly TakeEvent[], entries: readonly RedactEntry[]): RedactionTrack {
  const bySelector = new Map<string, Change[]>();
  for (const event of events)
    if (event.k === "redact") {
      const changes = bySelector.get(event.sel) ?? [];
      changes.push({ t: event.t, rects: event.rects as Rect[] });
      bySelector.set(event.sel, changes);
    }
  for (const changes of bySelector.values()) changes.sort((a, b) => a.t - b.t);
  const grow = ([x, y, width, height]: Rect): Rect => [
    x - REDACT_MARGIN,
    y - REDACT_MARGIN,
    width + 2 * REDACT_MARGIN,
    height + 2 * REDACT_MARGIN,
  ];

  const at = (timeMs: number): RedactBox[] => {
    const boxes: RedactBox[] = [];
    for (const entry of entries) {
      if ("rect" in entry) {
        if (timeMs >= entry.fromMs && timeMs < entry.toMs) boxes.push({ rect: entry.rect as Rect, mode: entry.mode });
        continue;
      }
      const changes = bySelector.get(entry.sel);
      if (!changes) continue;
      // The change in force at the start of the window, and every change inside it.
      const from = timeMs - REDACT_GUARD_MS,
        to = timeMs + REDACT_GUARD_MS;
      const held = lastAtOrBefore(changes, from);
      for (let index = Math.max(0, held); index < changes.length && changes[index]!.t <= to; index++)
        for (const rect of changes[index]!.rects) boxes.push({ rect: grow(rect), mode: entry.mode });
    }
    return boxes;
  };
  const empty = entries.every((entry) => "sel" in entry && !bySelector.has(entry.sel));
  return { at, empty };
}

/** Index of the last change at or before `t`, or -1 if none. Changes are sorted by time. */
function lastAtOrBefore(changes: readonly Change[], t: number): number {
  let low = 0,
    high = changes.length - 1,
    found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (changes[middle]!.t <= t) {
      found = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return found;
}
