import { ALL_FORMATS, Input, UrlSource, type VideoSample, VideoSampleSink } from "mediabunny";

/** Decoded video frames by timestamp.
 * A recording has a variable frame rate (a tab capture emits a frame only when the page
 * repaints), so "the frame at time t" is the latest frame whose timestamp is not after t.
 * Playback and export ask for increasing times, which is served by one forward decode;
 * a jump elsewhere restarts decoding from the nearest keyframe.
 */
export type FrameSource = {
  durationMs: number;
  width: number;
  height: number;
  /** The frame showing at `seconds`, or null before the first frame. Owned by the source: do not close it. */
  frameAt(seconds: number): Promise<VideoSample | null>;
  close(): void;
};

/** A request further ahead than this is treated as a jump, not as playback. */
const JUMP_SECONDS = 1.5;

export async function openFrameSource(url: string): Promise<FrameSource> {
  const input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error("This recording has no video track.");
  if (!(await track.canDecode()))
    throw new Error(`This browser cannot decode the recording's video codec (${track.codec ?? "unknown"}).`);
  const sink = new VideoSampleSink(track);
  const durationMs = (await input.computeDuration()) * 1000;
  let current: VideoSample | null = null;
  let next: VideoSample | null = null;
  let iterator: AsyncGenerator<VideoSample, void, unknown> | null = null;
  let closed = false;

  const reset = async () => {
    await iterator?.return();
    iterator = null;
    current?.close();
    next?.close();
    current = next = null;
  };
  return {
    durationMs,
    width: track.displayWidth,
    height: track.displayHeight,
    async frameAt(seconds) {
      if (closed) return null;
      const time = Math.max(0, seconds);
      if (!iterator || !current || time < current.timestamp || time > current.timestamp + JUMP_SECONDS) {
        await reset();
        current = await sink.getSample(time);
        iterator = sink.samples(current ? current.timestamp : time);
      }
      for (;;) {
        if (!next) {
          const step = await iterator.next();
          if (step.done) break;
          // The iterator starts at the frame we already hold.
          if (current && step.value.timestamp <= current.timestamp) {
            step.value.close();
            continue;
          }
          next = step.value;
        }
        if (next.timestamp > time) break;
        current?.close();
        current = next;
        next = null;
      }
      return current && current.timestamp <= time ? current : null;
    },
    close() {
      closed = true;
      void reset().finally(() => input.dispose());
    },
  };
}
