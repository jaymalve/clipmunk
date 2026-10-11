import { useCallback, useEffect, useRef, useState } from "react";

/** Save a value a moment after it stops changing.
 * Saves run one at a time and in order. A failed save keeps the value marked as unsaved,
 * so the next change, or `flush`, tries again. `write` returns a message when it fails.
 */
export type SaveState = "saved" | "saving" | { problem: string };

export function useAutosave<T>(value: T, write: (value: T) => Promise<string | undefined>, delayMs = 500) {
  const [state, setState] = useState<SaveState>("saved");
  // The first value is what is already on disk.
  const saved = useRef(value);
  const latest = useRef(value);
  latest.current = value;
  const writer = useRef(write);
  writer.current = write;
  const queue = useRef<Promise<void>>(Promise.resolve());

  const save = useCallback((next: T) => {
    queue.current = queue.current.then(async () => {
      if (next === saved.current) return;
      setState("saving");
      const problem = await writer.current(next);
      if (problem === undefined) saved.current = next;
      setState(problem === undefined ? "saved" : { problem });
    });
    return queue.current;
  }, []);

  useEffect(() => {
    if (value === saved.current) return;
    const timer = setTimeout(() => void save(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, save, delayMs]);

  /** Save the latest value now, for instance before an export reads the file. */
  const flush = useCallback(() => save(latest.current), [save]);
  return { state, flush };
}

export function SaveStatus({ state }: { state: SaveState }) {
  if (typeof state === "object") return <span className="save bad">{state.problem}</span>;
  return <span className="save">{state === "saved" ? "Saved" : "Saving…"}</span>;
}
