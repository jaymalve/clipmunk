import { type RefObject, useEffect, useState } from "react";
import { installBridge, PROGRESS_BINDING, WRITE_BINDING } from "../bridge";
import { createTakeRenderer, type TakeRenderer } from "../compositor";
import type { Span, Take, TakeEvent, TimeMap } from "../core";
import type { Clock } from "../react";

/** The moving parts behind the take editor, one concern per hook. */

/** Open the take's media once the canvas exists. Later edits go through `renderer.update`. */
export function useTakeRenderer(
  canvas: HTMLCanvasElement | null,
  take: Take,
  events: readonly TakeEvent[],
  fileUrl: (name: string) => string,
  speech: readonly Span[] = [],
) {
  const [renderer, setRenderer] = useState<TakeRenderer>();
  const [failure, setFailure] = useState<string>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: opened once per canvas; the take that was current then is the right one to open with
  useEffect(() => {
    if (!canvas) return;
    let current = true;
    let opened: TakeRenderer | undefined;
    createTakeRenderer({ take, events, fileUrl, canvas, speech }).then(
      (value) => {
        if (!current) return value.close();
        opened = value;
        setRenderer(value);
      },
      (error: unknown) => current && setFailure(error instanceof Error ? error.message : String(error)),
    );
    return () => {
      current = false;
      opened?.close();
    };
  }, [canvas]);
  return { renderer, failure };
}

/** Keep the preview showing the current edit at the clock's time. */
export function usePreview(renderer: TakeRenderer | undefined, take: Take, clock: Clock) {
  useEffect(() => {
    if (!renderer) return;
    renderer.update(take);
    void renderer.renderAt(clock.get());
    return clock.subscribe(() => void renderer.renderAt(clock.get()));
  }, [renderer, take, clock]);
}

/** Play the voice track alongside the clock, through the take's time map. Sped-up stretches are
 * silent, as in the export; the player is moved back into step whenever it drifts.
 */
export function useVoice(
  element: RefObject<HTMLAudioElement | null>,
  take: Take,
  timeMap: TimeMap,
  clock: Clock,
  playing: boolean,
) {
  const voice = take.source.audio;
  const { gain, muted } = take.edit.audio;
  useEffect(() => {
    const player = element.current;
    if (!player || !voice) return;
    player.volume = Math.min(1, gain);
    if (!playing) {
      player.pause();
      return;
    }
    const follow = () => {
      const clipMs = clock.get();
      const fast = timeMap.speedAt(clipMs) !== 1;
      player.muted = muted || fast;
      if (fast) return;
      const target = Math.max(0, (timeMap.toTake(clipMs) - voice.offsetMs) / 1000);
      if (Math.abs(player.currentTime - target) > 0.12) player.currentTime = target;
    };
    follow();
    void player.play().catch(() => {});
    return clock.subscribe(follow);
  }, [element, playing, voice, gain, muted, timeMap, clock]);
}

const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);

/** Binary crosses to the exporter as base64, in pieces small enough for one call. */
function toBase64(data: Uint8Array): string {
  let text = "";
  for (let i = 0; i < data.length; i += 32768) text += String.fromCharCode(...data.subarray(i, i + 32768));
  return btoa(text);
}

/** Expose the take to the exporter, which drives the same renderer the preview uses. */
export function useTakeBridge(
  renderer: TakeRenderer | undefined,
  take: Take,
  durationMs: number,
  clock: Clock,
  seek: (timeMs: number) => void,
) {
  const { width, height } = take.edit.canvas;
  useEffect(() => {
    if (!renderer) return;
    return installBridge({
      version: 1,
      kind: "take",
      durationMs,
      width,
      height,
      selector: "canvas[data-clipmunk-take]",
      ready: async () => renderer.renderAt(clock.get()),
      async seek(timeMs) {
        seek(timeMs);
        await renderer.renderAt(clock.get());
      },
      async encode(job) {
        const bindings = window as unknown as Record<string, ((...args: unknown[]) => Promise<void>) | undefined>;
        const write = bindings[WRITE_BINDING],
          progress = bindings[PROGRESS_BINDING];
        if (!write) throw new Error("No writer is attached to this page.");
        // One dimension given: the other follows the canvas's shape.
        const scale = job.height ? job.height / height : job.width ? job.width / width : 1;
        const size = { width: job.width ?? even(width * scale), height: job.height ?? even(height * scale) };
        return renderer.encode(
          { fps: job.fps, ...size },
          async (data, position) => void (await write(toBase64(data), position)),
          (done, total) => void progress?.(done, total),
        );
      },
    });
  }, [renderer, width, height, durationMs, clock, seek]);
}
