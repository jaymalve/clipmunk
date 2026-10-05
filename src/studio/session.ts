import { useCallback, useEffect, useRef, useState } from "react";
import type { Clock } from "../react";

/** Playback for one clip: the only place that advances the clock in real time.
 * Scrubbing and capture write the same clock, so every consumer sees one cursor.
 */
export function useClipSession(clock: Clock, durationMs: number, enabled: boolean) {
  const [playing, setPlaying] = useState(false);
  const duration = useRef(durationMs);
  duration.current = durationMs;

  const pause = useCallback(() => setPlaying(false), []);
  const seek = useCallback(
    (timeMs: number) => {
      if (!Number.isFinite(timeMs)) return;
      setPlaying(false);
      clock.set(Math.max(0, Math.min(duration.current, timeMs)));
    },
    [clock],
  );
  const toggle = useCallback(() => {
    if (!enabled || !duration.current) return;
    if (clock.get() >= duration.current) clock.set(0);
    setPlaying((value) => !value);
  }, [clock, enabled]);

  // A shorter duration after a source edit must not leave the cursor past the end.
  useEffect(() => {
    if (clock.get() > durationMs) clock.set(durationMs);
  }, [clock, durationMs]);
  useEffect(() => {
    if (!enabled) setPlaying(false);
  }, [enabled]);

  useEffect(() => {
    if (!playing || !durationMs) return;
    const started = performance.now() - clock.get();
    let frame = requestAnimationFrame(function tick(now) {
      const next = Math.min(durationMs, now - started);
      clock.set(next);
      if (next < durationMs) frame = requestAnimationFrame(tick);
      else setPlaying(false);
    });
    return () => cancelAnimationFrame(frame);
  }, [playing, durationMs, clock]);

  useEffect(() => {
    const hidden = () => document.hidden && setPlaying(false);
    document.addEventListener("visibilitychange", hidden);
    return () => document.removeEventListener("visibilitychange", hidden);
  }, []);

  return { playing, toggle, seek, pause };
}
