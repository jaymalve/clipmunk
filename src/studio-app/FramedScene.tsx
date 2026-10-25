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
import { type ChatContext, ChatPanel } from "../studio/Chat";
import { Chrome } from "../studio/Chrome";
import { type DaemonConnection, ExportPanel } from "../studio/daemon";
import { studioHref } from "../studio/links";
import { MusicControls } from "../studio/music";
import { Rail } from "../studio/Rail";
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
  // A second live frame, in another variant, to compare side by side; it follows the first one's time.
  const [compare, setCompare] = useState<SceneVariant>();
  const second = useRef<HTMLIFrameElement>(null);
  const secondSrc = (() => {
    if (!src || !compare) return undefined;
    const url = new URL(src);
    const text = formatVariant(compare);
    if (text) url.searchParams.set(VARIANT_PARAM, text);
    else url.searchParams.delete(VARIANT_PARAM);
    return url.toString();
  })();
  // Picking an element hides it in recordings, or adds it to the chat message being written.
  const [picking, setPicking] = useState<false | "hide" | "chat">(false);
  const pickingRef = useRef(picking);
  pickingRef.current = picking;
  const [chatOpen, setChatOpen] = useState(false);
  const [chips, setChips] = useState<ChatContext[]>([]);
  const [hidden, setHidden] = useState<string>();
  const [ready, setReady] = useState<{ durationMs: number; width: number; height: number }>();
  const [timeMs, setTimeMs] = useState(0);
  const timeRef = useRef(0);
  timeRef.current = timeMs;
  const [playing, setPlaying] = useState(false);
  const [narration, setNarration] = useState<{ phase: string; hasNarration: boolean }>();
  const [hostDown, setHostDown] = useState(false);
  const [panel, setPanel] = useState<"export" | "music">();
  const seq = useRef(0);

  const post = useCallback(
    (message: Record<string, unknown>, target: "first" | "both" = "both") => {
      if (!frameOrigin) return;
      frame.current?.contentWindow?.postMessage({ cm: 1, ...message }, frameOrigin);
      if (target === "both") second.current?.contentWindow?.postMessage({ cm: 1, ...message }, frameOrigin);
    },
    [frameOrigin],
  );

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.origin !== frameOrigin) return;
      const message = event.data as FrameMessage;
      if (message?.cm !== 1) return;
      // The compare frame only needs to be told where to be, once it is ready.
      if (event.source === second.current?.contentWindow) {
        if (message.type === "ready")
          second.current?.contentWindow?.postMessage({ cm: 1, type: "seek", t: timeRef.current, seq: 0 }, frameOrigin);
        return;
      }
      if (event.source !== frame.current?.contentWindow) return;
      if (message.type === "tick" && second.current)
        second.current.contentWindow?.postMessage({ cm: 1, type: "seek", t: Number(message.t), seq: 0 }, frameOrigin);
      if (message.type === "picked") {
        setPicking(false);
        frame.current?.contentWindow?.postMessage({ cm: 1, type: "pick", on: false }, frameOrigin);
        const el = message.el as { sel?: string; name?: string; role?: string } | undefined;
        const selector = el?.sel;
        if (selector && pickingRef.current === "chat")
          setChips((current) => [
            ...current,
            {
              kind: "element",
              sel: selector,
              ...(el.name ? { name: el.name } : {}),
              ...(el.role ? { role: el.role } : {}),
            },
          ]);
        else if (selector)
          void client.post<{ selectors: string[] }>("/v1/config/redact", { selector }).then((result) => {
            setHidden(result.ok ? selector : `not added: ${result.issues[0]?.message}`);
          });
      }
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
  }, [frameOrigin, client]);

  // No `ready` in a few seconds usually means the host's dev server is not running.
  useEffect(() => {
    if (ready || !src) return;
    const timer = setTimeout(() => setHostDown(true), 8000);
    return () => clearTimeout(timer);
  }, [ready, src]);

  const chooseVariant = (next: SceneVariant) => {
    setVariant(next);
    const text = formatVariant(next);
    post({ type: "variant", variant: text }, "first");
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
      <Chrome style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 190 }}>
        <Rail client={client} current={{ kind: "scene", id: scene.id }} />
      </Chrome>
      <div style={{ position: "absolute", left: 190, right: 0, top: 0, bottom: 64, display: "flex" }}>
        {src && (
          <iframe
            ref={frame}
            title={scene.title}
            src={src}
            data-clipmunk-frame={scene.id}
            allow="autoplay; microphone; camera"
            style={{ flex: 1, height: "100%", border: 0 }}
          />
        )}
        {secondSrc && (
          <iframe
            key={secondSrc}
            ref={second}
            title={`${scene.title}, compared`}
            src={secondSrc}
            data-clipmunk-compare={scene.id}
            style={{ flex: 1, height: "100%", border: 0, borderLeft: "1px solid #27272a" }}
          />
        )}
      </div>
      {chatOpen && (
        <Chrome style={{ position: "absolute", right: 16, bottom: 76, zIndex: 11 }}>
          <ChatPanel
            client={client}
            clip={{ kind: "scene", id: scene.id }}
            chips={chips}
            onChips={setChips}
            moment={() => timeRef.current}
            onPickElement={
              ready
                ? () => {
                    setPicking("chat");
                    post({ type: "pick", on: true }, "first");
                  }
                : undefined
            }
            onClose={() => setChatOpen(false)}
          />
        </Chrome>
      )}
      <Chrome style={{ position: "absolute", left: 206, right: 16, bottom: 12, zIndex: 10 }}>
        {hidden && (
          <div className="note" role="status">
            {hidden.startsWith("not added")
              ? `The element was ${hidden}`
              : `Recordings will hide ${hidden} (added to clipmunk.config.json).`}
          </div>
        )}
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
          <span className="hint">Preview as</span>
          <VariantSelect label="Preview as" value={variant} options={variantOptions} onChange={chooseVariant} />
          <button
            type="button"
            aria-pressed={!!compare}
            onClick={() =>
              setCompare((value) =>
                value ? undefined : { ...variant, ratio: variant.ratio === "9:16" ? undefined : "9:16" },
              )
            }
          >
            Compare
          </button>
          {compare && (
            <VariantSelect label="Compare with" value={compare} options={variantOptions} onChange={setCompare} />
          )}
          <button
            type="button"
            aria-pressed={picking === "hide"}
            disabled={!ready}
            onClick={() => {
              setPicking(picking ? false : "hide");
              post({ type: "pick", on: !picking }, "first");
            }}
          >
            {picking === "hide" ? "Click an element…" : "Pick an element to hide"}
          </button>
          <button type="button" aria-pressed={chatOpen} onClick={() => setChatOpen((value) => !value)}>
            Chat
          </button>
          <button type="button" onClick={() => setPanel((value) => (value === "export" ? undefined : "export"))}>
            Export
          </button>
        </div>
      </Chrome>
    </div>
  );
}
