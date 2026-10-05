/** The single presentation cursor of a clip, in elapsed milliseconds.
 * Playback, scrubbing and capture all write here; renderers subscribe and never read wall-clock time.
 */
export type Clock = {
  get(): number;
  set(timeMs: number): void;
  subscribe(listener: () => void): () => void;
};

export function createClock(initialMs = 0): Clock {
  let time = initialMs;
  const listeners = new Set<() => void>();
  return {
    get: () => time,
    set(next) {
      if (!Number.isFinite(next) || next === time) return;
      time = Math.max(0, next);
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
