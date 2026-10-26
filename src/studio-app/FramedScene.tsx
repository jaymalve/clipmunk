import { useCallback, useEffect, useRef, useState } from "react";
import {
  type CatalogScene,
  DAEMON_HASH,
  formatVariant,
  frameUrl,
  type Music,
  parseVariant,
  type SceneVariant,
  VARIANT_PARAM,
} from "../core";
import { Chrome } from "../studio/Chrome";
import { type DaemonConnection, ExportPanel } from "../studio/daemon";
import { studioHref } from "../studio/links";
import { MusicControls } from "../studio/music";
import { VariantSelect } from "../studio/ScenePreview";

/** The scene player of the standalone Studio: the host's frame page in an iframe, driven with
 * the frame protocol (studio/frame-agent.ts), with the controls here. The frame owns the clock
 * while it plays; the Studio shows the time it reports.
 */
type FrameMessage = { cm: 1; type: string; [key: string]: unknown };
const formatTime = (ms: number) => `${(ms / 1000).toFixed(2)}s`;

export function FramedScene({ scene, daemon }: { scene: CatalogScene; daemon: DaemonConnection }) {
  const { client, status } = daemon;
  const devUrl = status.devUrl;
  const frame = useRef<HTMLIFrameElement>(null);
  const [variant, setVariant] = useState<SceneVariant>(() =>
    parseVariant(new URLSearchParams(location.search).get(VARIANT_PARAM)),
  );
  // The iframe's address is fixed when it opens; later variants go by message, so it never reloads.
  const [src] = useState(() => {
    if (!devUrl) return undefined;
    const url = new URL(frameUrl(devUrl, status.studioPath ?? "/", scene.id));
    const text = formatVariant(variant);
    if (text) url.searchParams.set(VARIANT_PARAM, text);
    url.hash = `${DAEMON_HASH}=${client.link.port}.${client.link.token}`;
    return url.toString();
  });
  const frameOrigin = src ? new URL(src).origin : undefined;
  const [ready, setReady] = useState<{ durationMs: number; width: number; height: number }>();
  const [timeMs, setTimeMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [narration, setNarration] = useState<{ phase: string; hasNarration: boolean }>();
  const [hostDown, setHostDown] = useState(false);
  const [panel, setPanel] = useState<"export" | "music">();
  const seq = useRef(0);

  const post = useCallback(
    (message: Record<string, unknown>) => {
      if (frameOrigin) frame.current?.contentWindow?.postMessage({ cm: 1, ...message }, frameOrigin);
    },
    [frameOrigin],
  );

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.origin !== frameOrigin || event.source !== frame.current?.contentWindow) return;
      const message = event.data as FrameMessage;
      if (message?.cm !== 1) return;
      if (message.type === "ready") {
        setReady({
          durationMs: Number(message.durationMs),
          width: Number(message.width),
          height: Number(message.height),
        });
        setHostDown(false);
      }
      if (message.type === "frame" || message.type === "tick") setTimeMs(Number(message.t));
      if (message.type === "tick") setPlaying(true);
      if (message.type === "stopped") {
        setPlaying(false);
        setTimeMs(Number(message.t));
      }
      if (message.type === "narration")
        setNarration({ phase: String(message.phase), hasNarration: !!message.hasNarration });
    };
    addEventListener("message", receive);
    return () => removeEventListener("message", receive);
  }, [frameOrigin]);

  // No `ready` in a few seconds usually means the host's dev server is not running.
  useEffect(() => {
    if (ready || !src) return;
    const timer = setTimeout(() => setHostDown(true), 8000);
    return () => clearTimeout(timer);
  }, [ready, src]);

  const chooseVariant = (next: SceneVariant) => {
    setVariant(next);
    const text = formatVariant(next);
    post({ type: "variant", variant: text });
    const url = new URL(location.href);
    if (text) url.searchParams.set(VARIANT_PARAM, text);
    else url.searchParams.delete(VARIANT_PARAM);
    history.replaceState(history.state, "", url);
  };
  const seek = (t: number) => {
    setTimeMs(t);
    post({ type: "seek", t, seq: ++seq.current });
  };
  const durationMs = ready?.durationMs ?? 0;

  const [variantOptions, setVariantOptions] = useState({ themes: [] as string[], locales: [] as string[] });
  useEffect(() => {
    void client
      .get<{ config: { variants?: { themes?: string[]; locales?: string[] } } }>("/v1/config")
      .then((result) => {
        const variants = result.ok ? result.data.config.variants : undefined;
        setVariantOptions({ themes: variants?.themes ?? [], locales: variants?.locales ?? [] });
      });
  }, [client]);

  const [music, setMusic] = useState<Music | undefined>(scene.music);
  useEffect(() => setMusic(scene.music), [scene.music]);
  const saveMusic = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const changeMusic = (next: Music | undefined) => {
    setMusic(next);
    clearTimeout(saveMusic.current);
    saveMusic.current = setTimeout(() => {
      void client.put(
        `/v1/scenes/${scene.id}/music`,
        new Blob([JSON.stringify({ music: next ?? null })], { type: "application/json" }),
      );
    }, 400);
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "#000" }}>
      {src && (
        <iframe
          ref={frame}
          title={scene.title}
          src={src}
          data-clipmunk-frame={scene.id}
          allow="autoplay; microphone; camera"
          style={{ position: "absolute", inset: "0 0 64px 0", width: "100%", height: "calc(100% - 64px)", border: 0 }}
        />
      )}
      <Chrome style={{ position: "absolute", left: 16, right: 16, bottom: 12, zIndex: 10 }}>
        {(!devUrl || hostDown) && (
          <div className="issues" role="alert">
            {devUrl
              ? `Your app's dev server is not answering at ${devUrl}. Start it (for example npm run dev) to preview this scene; takes, sequences and export work without it.`
              : "This project has no dev server address yet. Run npx clipmunk init in it."}
          </div>
        )}
        {panel === "export" && (
          <ExportPanel
            clip={{ sceneId: scene.id, ...(formatVariant(variant) ? { variant: formatVariant(variant) } : {}) }}
            daemon={daemon}
            frame={ready ? { width: ready.width, height: ready.height } : undefined}
            url={devUrl}
          />
        )}
        {panel === "music" && (
          <div className="musicbox">
            <MusicControls
              value={music}
              hasVoice={!!narration?.hasNarration}
              clipKey={`scene:${scene.id}`}
              moments={0}
              onChange={changeMusic}
            />
          </div>
        )}
        <div className="bar">
          <a href={studioHref()}>← Studio</a>
          <span className="title">{scene.title}</span>
          <button
            type="button"
            disabled={!ready || !durationMs}
            onClick={() =>
              playing ? post({ type: "pause" }) : post({ type: "play", from: timeMs >= durationMs ? 0 : timeMs })
            }
          >
            {playing ? "Pause" : timeMs >= durationMs && durationMs ? "Replay" : "Play"}
          </button>
          <input
            type="range"
            aria-label="Scene time"
            min={0}
            max={durationMs || 1}
            step={1}
            value={Math.min(timeMs, durationMs)}
            disabled={!ready || !durationMs}
            onChange={(event) => seek(Number(event.currentTarget.value))}
          />
          <span className="time">{ready ? `${formatTime(timeMs)} / ${formatTime(durationMs)}` : "Loading…"}</span>
          {narration && (
            <button
              type="button"
              disabled={playing && narration.phase !== "recording"}
              onClick={() => post({ type: "narrate", action: narration.phase === "recording" ? "stop" : "start" })}
            >
              {narration.phase === "recording"
                ? "Stop narrating"
                : narration.hasNarration
                  ? "Re-record narration"
                  : "Narrate"}
            </button>
          )}
          {narration?.hasNarration && narration.phase === "idle" && (
            <button type="button" disabled={playing} onClick={() => post({ type: "narrate", action: "remove" })}>
              Remove narration
            </button>
          )}
          <button type="button" onClick={() => setPanel((value) => (value === "music" ? undefined : "music"))}>
            {music ? "Music ♪" : "Music"}
          </button>
          <VariantSelect value={variant} options={variantOptions} onChange={chooseVariant} />
          <button type="button" onClick={() => setPanel((value) => (value === "export" ? undefined : "export"))}>
            Export
          </button>
        </div>
      </Chrome>
    </div>
  );
}
