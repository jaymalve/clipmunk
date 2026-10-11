import { useCallback, useEffect, useRef, useState } from "react";
import type { AudioClip } from "../core";
import type { Clock } from "../react";
import type { DaemonClient } from "../recorder";

/** Sound attached to a scene: plays alongside the clock in the preview, and records
 * narration by playing the scene from the start while the microphone is captured.
 */
const isNarration = (sceneId: string, clip: AudioClip) => clip.file.startsWith(`${sceneId}-narration-`);

export function useNarration(options: {
  sceneId?: string;
  audio?: AudioClip[];
  client?: DaemonClient;
  clock: Clock;
  durationMs: number;
  playing: boolean;
  seek(ms: number): void;
  toggle(): void;
}) {
  const { sceneId, client, clock, playing } = options;
  // The recipe file is the source of truth; this mirrors it until the dev server reloads the module.
  const [clips, setClips] = useState(options.audio ?? []);
  useEffect(() => setClips(options.audio ?? []), [options.audio]);
  const [state, setState] = useState<{ phase: "idle" | "recording" | "saving" } | { phase: "error"; message: string }>({
    phase: "idle",
  });
  const players = useRef(new Map<string, HTMLAudioElement>());

  // Preview playback: one audio element per clip, started at the right point when playback starts.
  useEffect(() => {
    if (!client) return;
    const wanted = new Set(clips.map((clip) => clip.file));
    for (const [file, element] of players.current) {
      if (wanted.has(file)) continue;
      element.pause();
      players.current.delete(file);
    }
    for (const clip of clips)
      if (!players.current.has(clip.file))
        players.current.set(
          clip.file,
          Object.assign(new Audio(client.url(`/v1/audio/${clip.file}`)), { preload: "auto" }),
        );
    for (const clip of clips) {
      const element = players.current.get(clip.file)!;
      element.volume = Math.min(1, clip.gain);
      const position = (clock.get() - clip.offsetMs) / 1000;
      if (!playing || state.phase === "recording" || position < 0) element.pause();
      else {
        element.currentTime = position;
        void element.play().catch(() => {});
      }
    }
    return () => {
      for (const element of players.current.values()) element.pause();
    };
  }, [clips, client, playing, clock, state.phase]);

  const session = useRef<{ recorder: MediaRecorder; stream: MediaStream } | undefined>(undefined);
  const stop = useCallback(() => {
    if (session.current?.recorder.state === "recording") session.current.recorder.stop();
  }, []);
  // The take ends when the scene does.
  useEffect(() => {
    if (state.phase === "recording" && !playing && clock.get() > 0) stop();
  }, [playing, state.phase, clock, stop]);

  async function start() {
    if (!client || !sceneId || !options.durationMs) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      const recorder = new MediaRecorder(stream, {
        mimeType: ["audio/webm;codecs=opus", "audio/webm"].find((type) => MediaRecorder.isTypeSupported(type)),
      });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => chunks.push(event.data);
      options.seek(0);
      const recordingStarted = performance.now();
      recorder.start();
      options.toggle();
      const playStarted = performance.now();
      session.current = { recorder, stream };
      setState({ phase: "recording" });
      recorder.onstop = async () => {
        for (const track of stream.getTracks()) track.stop();
        session.current = undefined;
        setState({ phase: "saving" });
        // The microphone started slightly before playback did; that head start is the clip's offset.
        const result = await client.put<{ audio: AudioClip[] }>(
          `/v1/scenes/${sceneId}/narration?offset=${Math.round(recordingStarted - playStarted)}`,
          new Blob(chunks, { type: recorder.mimeType }),
        );
        if (result.ok) {
          setClips(result.data.audio);
          setState({ phase: "idle" });
        } else setState({ phase: "error", message: result.issues[0]!.message });
      };
    } catch (error) {
      setState({
        phase: "error",
        message:
          error instanceof DOMException && error.name === "NotAllowedError"
            ? "The microphone was not allowed."
            : error instanceof Error
              ? error.message
              : String(error),
      });
    }
  }
  async function remove() {
    if (!client || !sceneId) return;
    const result = await client.remove<{ audio: AudioClip[] }>(`/v1/scenes/${sceneId}/narration`);
    if (result.ok) setClips(result.data.audio);
    else setState({ phase: "error", message: result.issues[0]!.message });
  }

  return {
    available: !!client && !!sceneId && options.durationMs > 0,
    hasNarration: !!sceneId && clips.some((clip) => isNarration(sceneId, clip)),
    state,
    start,
    stop,
    remove,
  };
}
