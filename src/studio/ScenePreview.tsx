import {
  Component,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { flushSync } from "react-dom";
import { CAPTURE_SELECTOR, installBridge } from "../bridge";
import {
  type AudioClip,
  formatVariant,
  type Issue,
  type Music,
  motionDuration,
  parseVariant,
  RATIOS,
  type SceneDefinition,
  type SceneVariant,
  type Sound,
  sceneMoments,
  VARIANT_PARAM,
  validateDefinition,
  variantFrame,
} from "../core";
import { createClock, Scene, SceneVariantProvider } from "../react";
import { Chrome } from "./Chrome";
import { type DaemonState, ExportPanel } from "./daemon";
import { useFrameAgent } from "./frame-agent";
import { IssueList } from "./IssueList";
import { MusicControls, useMusicPreview, useSoundsPreview } from "./music";
import { useNarration } from "./narration";
import { useClipSession } from "./session";

/** The shared player for one scene: validates the recipe definition, fits the authored
 * frame into the viewport, and owns playback. Scene files supply only Surface children.
 */
export type ScenePreviewProps = {
  /** The `definition` object of a scene recipe. Validated here; pass it as parsed JSON. */
  definition: unknown;
  title?: string;
  /** Link back to the library, if any. */
  backHref?: string;
  /** Enables export in the controls. */
  sceneId?: string;
  /** When connected, export runs here with progress; otherwise the CLI command is shown. */
  daemon?: DaemonState;
  /** The recipe's sound clips: narration and anything else attached to the scene. */
  audio?: AudioClip[];
  /** The recipe's generated music. */
  music?: Music;
  /** The recipe's generated sound effects. */
  sounds?: readonly Sound[];
  /** The frame page: only the scene, no controls, driven by the Studio's messages (frame-agent.ts). */
  bare?: boolean;
  children?: ReactNode;
};

const formatTime = (ms: number) => `${(ms / 1000).toFixed(2)}s`;

export function ScenePreview({
  definition,
  title,
  backHref,
  sceneId,
  daemon,
  audio,
  music: recipeMusic,
  sounds,
  bare = false,
  children,
}: ScenePreviewProps) {
  const result = useMemo(() => validateDefinition(definition), [definition]);
  // Keep the last valid definition on screen while the source is broken.
  const accepted = useRef<SceneDefinition | null>(null);
  if (result.ok) accepted.current = result.data;
  const current = accepted.current;

  const [clock] = useState(() => createClock());
  const [renderIssues, setRenderIssues] = useState<Issue[]>([]);
  const [failure, setFailure] = useState<Error | null>(null);
  const issues = result.ok ? renderIssues : result.issues;
  const durationMs = current?.motion ? motionDuration(current.motion) : 0;
  const valid = !!current && result.ok && issues.length === 0 && !failure;
  const session = useClipSession(clock, durationMs, valid);
  // The variant comes from the page address, so the exporter opens the same one.
  const [variant, setVariant] = useState<SceneVariant>(() =>
    parseVariant(new URLSearchParams(location.search).get(VARIANT_PARAM)),
  );
  const chooseVariant = (next: SceneVariant) => {
    setVariant(next);
    const url = new URL(location.href);
    const text = formatVariant(next);
    if (text) url.searchParams.set(VARIANT_PARAM, text);
    else url.searchParams.delete(VARIANT_PARAM);
    history.replaceState(history.state, "", url);
  };
  const frame = current ? variantFrame(current, variant.ratio) : undefined;
  const width = frame?.width ?? 1400,
    height = frame?.height ?? 980;
  const [variantOptions, setVariantOptions] = useState<{ themes: string[]; locales: string[] }>({
    themes: [],
    locales: [],
  });
  useEffect(() => {
    if (!daemon?.client) return;
    void daemon.client
      .get<{ config: { variants?: { themes?: string[]; locales?: string[] } } }>("/v1/config")
      .then((result) => {
        const variants = result.ok ? result.data.config.variants : undefined;
        setVariantOptions({ themes: variants?.themes ?? [], locales: variants?.locales ?? [] });
      });
  }, [daemon?.client]);
  const [exporting, setExporting] = useState(false);
  // The recipe file is the source of truth; this mirrors it until the dev server reloads the module.
  const [music, setMusic] = useState(recipeMusic);
  useEffect(() => setMusic(recipeMusic), [recipeMusic]);
  const [choosingMusic, setChoosingMusic] = useState(false);
  const [musicIssue, setMusicIssue] = useState<string>();
  const saveMusic = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const changeMusic = (next: Music | undefined) => {
    setMusic(next);
    clearTimeout(saveMusic.current);
    saveMusic.current = setTimeout(async () => {
      const result = await daemon!.client!.put<unknown>(
        `/v1/scenes/${sceneId}/music`,
        new Blob([JSON.stringify({ music: next ?? null })], { type: "application/json" }),
      );
      setMusicIssue(result.ok ? undefined : result.issues[0]!.message);
    }, 400);
  };
  const moments = useMemo(() => (current ? sceneMoments(current) : []), [current]);
  useMusicPreview({
    music,
    clip: { key: `scene:${sceneId ?? ""}`, durationMs, momentsMs: moments },
    clock,
    playing: session.playing,
  });
  useSoundsPreview({
    sounds,
    speed: current?.motion?.speed,
    clip: { key: `scene:${sceneId ?? ""}`, durationMs },
    clock,
    playing: session.playing,
  });
  const narration = useNarration({
    sceneId,
    audio,
    client: daemon?.client,
    clock,
    durationMs,
    playing: session.playing,
    seek: session.seek,
    toggle: session.toggle,
  });

  // The exporter drives this same clock. Capture refuses a scene with unresolved issues.
  const validRef = useRef(valid);
  validRef.current = valid;
  const hasScene = !!current;
  useEffect(() => {
    if (!hasScene) return;
    const settled = async () => {
      await document.fonts.ready;
      const images = Array.from(document.querySelectorAll<HTMLImageElement>(`${CAPTURE_SELECTOR} img`));
      await Promise.all(images.map((image) => image.decode().catch(() => undefined)));
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    };
    return installBridge({
      version: 1,
      kind: "scene",
      durationMs,
      width,
      height,
      selector: CAPTURE_SELECTOR,
      ready: settled,
      async seek(timeMs) {
        if (!Number.isFinite(timeMs) || timeMs < 0 || timeMs > durationMs + 1e-6)
          throw new Error(`Time ${timeMs} is outside the scene (0 to ${durationMs} ms).`);
        // flushSync commits components that read useSceneTime before the frame is captured.
        flushSync(() => session.seek(timeMs));
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
        if (!validRef.current)
          throw new Error("The scene has unresolved issues. Open it in the studio and fix them before capturing.");
      },
    });
  }, [hasScene, durationMs, width, height, session.seek]);

  const daemonPort = daemon?.client ? Number(new URL(daemon.client.url("/")).port) || undefined : undefined;
  useFrameAgent(bare, daemonPort, {
    clock,
    durationMs,
    width,
    height,
    version: definition,
    ready: valid,
    seek: session.seek,
    play: session.play,
    pause: session.pause,
    playing: session.playing,
    variant,
    setVariant: chooseVariant,
    narration: narration.available
      ? {
          start: narration.start,
          stop: narration.stop,
          remove: narration.remove,
          phase: narration.state.phase,
          has: narration.hasNarration,
        }
      : undefined,
  });

  const viewport = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState({ scale: 1, left: 0, top: 0 });
  useLayoutEffect(() => {
    const element = viewport.current!;
    const update = () => {
      const scale = Math.min(element.clientWidth / width, element.clientHeight / height) || 1;
      setFit({
        scale,
        left: (element.clientWidth - width * scale) / 2,
        top: (element.clientHeight - height * scale) / 2,
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [width, height]);

  return (
    <div data-clipmunk-preview="" style={{ position: "fixed", inset: 0, background: "#000", overflow: "hidden" }}>
      <div ref={viewport} style={{ position: "absolute", inset: 0 }}>
        {current && (
          <div
            data-clipmunk-capture="scene"
            data-clipmunk-scene-id={sceneId}
            style={{
              position: "absolute",
              left: fit.left,
              top: fit.top,
              width,
              height,
              overflow: "hidden",
              transform: `scale(${fit.scale})`,
              transformOrigin: "0 0",
            }}
          >
            <div
              style={{
                position: "absolute",
                left: frame!.scene.left,
                top: frame!.scene.top,
                width: frame!.scene.width,
                height: frame!.scene.height,
                transform: frame!.scene.scale === 1 ? undefined : `scale(${frame!.scene.scale})`,
                transformOrigin: "0 0",
              }}
            >
              <SceneBoundary resetKey={definition} onError={setFailure}>
                <SceneVariantProvider value={variant}>
                  <Scene
                    camera={frame!.camera ? { ...current.scene.camera, ...frame!.camera } : current.scene.camera}
                    focus={current.scene.focus}
                    nodes={current.scene.nodes}
                    motion={current.motion}
                    clock={clock}
                    quality={session.playing ? "preview" : "full"}
                    onDiagnostics={setRenderIssues}
                    style={{ width: frame!.scene.width, height: frame!.scene.height }}
                  >
                    {children}
                  </Scene>
                </SceneVariantProvider>
              </SceneBoundary>
            </div>
          </div>
        )}
      </div>
      {!bare && (
        <Chrome style={{ position: "absolute", left: 16, right: 16, bottom: 16, zIndex: 10 }}>
          {(issues.length > 0 || failure) && (
            <IssueList
              issues={issues}
              title={failure ? "A scene component failed to render." : "This scene needs a correction."}
            >
              {failure && <li>{failure.message}</li>}
            </IssueList>
          )}
          {!current && issues.length === 0 && <p className="empty">No scene to show.</p>}
          {exporting && sceneId && (
            <ExportPanel
              clip={{ sceneId, ...(formatVariant(variant) ? { variant: formatVariant(variant) } : {}) }}
              daemon={daemon}
              frame={{ width, height }}
            />
          )}
          {narration.state.phase === "error" && (
            <div className="issues" role="alert">
              {narration.state.message}
            </div>
          )}
          {musicIssue && (
            <div className="issues" role="alert">
              {musicIssue}
            </div>
          )}
          {choosingMusic && sceneId && daemon?.client && (
            <div className="musicbox">
              <MusicControls
                value={music}
                hasVoice={narration.hasNarration}
                clipKey={`scene:${sceneId}`}
                moments={moments.length}
                onChange={changeMusic}
              />
            </div>
          )}
          <Controls
            clock={clock}
            durationMs={durationMs}
            title={title}
            backHref={backHref}
            disabled={!valid}
            {...session}
            onExport={sceneId ? () => setExporting((value) => !value) : undefined}
            narration={narration}
            onMusic={
              sceneId && daemon?.client && durationMs > 0 ? () => setChoosingMusic((value) => !value) : undefined
            }
            hasMusic={!!music}
            variant={variant}
            variantOptions={variantOptions}
            onVariant={chooseVariant}
          />
        </Chrome>
      )}
    </div>
  );
}

function Controls(props: {
  clock: ReturnType<typeof createClock>;
  durationMs: number;
  title?: string;
  backHref?: string;
  disabled: boolean;
  playing: boolean;
  toggle: () => void;
  seek: (timeMs: number) => void;
  onExport?: () => void;
  narration?: ReturnType<typeof useNarration>;
  onMusic?: () => void;
  hasMusic?: boolean;
  variant: SceneVariant;
  variantOptions: { themes: string[]; locales: string[] };
  onVariant: (variant: SceneVariant) => void;
}) {
  const { clock, durationMs, disabled } = props;
  // Only this small component re-renders per frame; the scene itself is updated imperatively.
  const timeMs = useSyncExternalStore(clock.subscribe, clock.get, clock.get);
  const still = durationMs === 0;
  return (
    <div className="bar">
      {props.backHref && <a href={props.backHref}>← Scenes</a>}
      {props.title && <span className="title">{props.title}</span>}
      <button type="button" onClick={props.toggle} disabled={disabled || still}>
        {props.playing ? "Pause" : timeMs >= durationMs && !still ? "Replay" : "Play"}
      </button>
      <input
        type="range"
        aria-label="Scene time"
        min={0}
        max={durationMs || 1}
        step={1}
        value={Math.min(timeMs, durationMs)}
        disabled={disabled || still}
        onChange={(event) => props.seek(Number(event.currentTarget.value))}
      />
      <span className="time">{still ? "Still" : `${formatTime(timeMs)} / ${formatTime(durationMs)}`}</span>
      {props.narration?.available && (
        <>
          {props.narration.state.phase === "recording" ? (
            <button type="button" onClick={props.narration.stop}>
              Stop narrating
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void props.narration!.start()}
              disabled={disabled || props.playing || props.narration.state.phase === "saving"}
              title="Plays the scene from the start and records your microphone over it"
            >
              {props.narration.state.phase === "saving"
                ? "Saving…"
                : props.narration.hasNarration
                  ? "Re-record narration"
                  : "Narrate"}
            </button>
          )}
          {props.narration.hasNarration && props.narration.state.phase === "idle" && (
            <button type="button" onClick={() => void props.narration!.remove()} disabled={props.playing}>
              Remove narration
            </button>
          )}
        </>
      )}
      {props.onMusic && (
        <button type="button" onClick={props.onMusic}>
          {props.hasMusic ? "Music ♪" : "Music"}
        </button>
      )}
      <VariantSelect value={props.variant} options={props.variantOptions} onChange={props.onVariant} />
      {props.onExport && (
        <button type="button" onClick={props.onExport} disabled={disabled}>
          Export
        </button>
      )}
    </div>
  );
}

/** Catches a throwing scene component; a changed definition or a hot reload retries it. */
class SceneBoundary extends Component<
  { resetKey: unknown; onError: (error: Error | null) => void; children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    this.props.onError(error);
  }
  componentDidUpdate(previous: { resetKey: unknown }) {
    if (this.state.error && previous.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
      this.props.onError(null);
    }
  }
  render() {
    return this.state.error ? null : this.props.children;
  }
}

/** Every combination of the config's themes and locales with each ratio, as one select. */
export function VariantSelect(props: {
  value: SceneVariant;
  options: { themes: string[]; locales: string[] };
  onChange: (variant: SceneVariant) => void;
}) {
  const themes = [undefined, ...props.options.themes],
    locales = [undefined, ...props.options.locales],
    ratios = [undefined, ...RATIOS];
  const choices: { text: string; label: string; variant: SceneVariant }[] = [];
  for (const theme of themes)
    for (const locale of locales)
      for (const ratio of ratios) {
        const variant: SceneVariant = {
          ...(theme ? { theme } : {}),
          ...(locale ? { locale } : {}),
          ...(ratio ? { ratio } : {}),
        };
        const label = [theme, locale, ratio].filter(Boolean).join(" · ") || "Default";
        choices.push({ text: formatVariant(variant), label, variant });
      }
  const current = formatVariant(props.value);
  return (
    <select
      aria-label="Variant"
      value={current}
      onChange={(event) => {
        const chosen = choices.find((choice) => choice.text === event.currentTarget.value);
        if (chosen) props.onChange(chosen.variant);
      }}
    >
      {!choices.some((choice) => choice.text === current) && <option value={current}>{current}</option>}
      {choices.map((choice) => (
        <option key={choice.text} value={choice.text}>
          {choice.label}
        </option>
      ))}
    </select>
  );
}
