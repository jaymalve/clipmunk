import { STUDIO_PARAM, TAKE_PARAM } from "../core";
import { createRecorder, isSupported, type Recorder, type RecorderState } from "./capture";
import { connectDaemon } from "./daemon";

/** The recorder's on-page controls. It is a custom element appended to <html>, outside
 * <body>, so the restricted capture never includes it. Everything is plain DOM in a
 * shadow root: the recorder works in any web app, with or without React.
 */
const TAG = "flick-recorder";
const STYLES = `
:host { all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; font: 13px/1.3 system-ui, sans-serif; color: #f4f4f5; }
.bar { position: absolute; left: 50%; bottom: 20px; transform: translateX(-50%); display: flex; align-items: center; gap: 10px; pointer-events: auto;
  padding: 8px 10px 8px 14px; background: rgba(24,24,27,.94); border: 1px solid rgba(255,255,255,.14); border-radius: 999px; box-shadow: 0 10px 40px rgba(0,0,0,.45); white-space: nowrap; }
button { font: inherit; color: inherit; background: rgba(255,255,255,.1); border: 0; border-radius: 999px; padding: 7px 13px; cursor: pointer; }
button:hover:not(:disabled) { background: rgba(255,255,255,.2); } button:disabled { opacity: .45; cursor: default; }
button.primary { background: #ef4444; font-weight: 600; } button.primary:hover:not(:disabled) { background: #dc2626; }
button.on { background: rgba(74,222,128,.22); color: #bbf7d0; } button.ghost { background: none; padding: 7px 8px; color: #a1a1aa; }
.status { color: #a1a1aa; max-width: 60vw; overflow: hidden; text-overflow: ellipsis; } .status.error { color: #fca5a5; white-space: normal; max-width: 60vw; }
.dot { width: 9px; height: 9px; border-radius: 50%; background: #ef4444; animation: pulse 1.2s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: .35; } }
a { color: #a5f3fc; }
.cursor { position: absolute; left: 0; top: 0; width: 22px; height: 22px; margin: -2px 0 0 -3px; display: none; will-change: transform; filter: drop-shadow(0 1px 2px rgba(0,0,0,.5)); }
.cam { position: absolute; right: 24px; bottom: 24px; width: 180px; height: 180px; border-radius: 50%; object-fit: cover; transform: scaleX(-1); border: 3px solid rgba(255,255,255,.85); display: none; background: #000; }
`;
const ARROW = `<svg viewBox="0 0 22 22" xmlns="http://www.w3.org/2000/svg"><path d="M4 2.5v15.2l4.1-3.6 2.6 5.9 2.5-1.1-2.6-5.8 5.4-.4z" fill="#fff" stroke="#111" stroke-width="1.2" stroke-linejoin="round"/></svg>`;
const clock = (ms: number) =>
  `${String(Math.floor(ms / 60000)).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

export type RecorderHud = { open(): void; close(): void; toggle(): void; readonly recorder: Recorder | undefined };
let mounted: RecorderHud | undefined;

export function mountRecorderHud(): RecorderHud {
  if (mounted) return mounted;
  const host = document.createElement(TAG);
  host.setAttribute("data-flick-chrome", "");
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>${STYLES}</style><div class="cursor">${ARROW}</div><video class="cam" muted playsinline></video>
    <div class="bar" role="toolbar" aria-label="Flick recorder">
      <span class="dot" hidden></span><span class="status"></span>
      <button class="mic" type="button" aria-pressed="true">Mic</button><button class="camera" type="button" aria-pressed="false">Camera</button>
      <button class="discard" type="button" hidden>Discard</button><button class="primary action" type="button">Record</button><button class="ghost close" type="button" aria-label="Close recorder">✕</button>
    </div>`;
  const $ = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const status = $(".status"),
    action = $<HTMLButtonElement>(".action"),
    mic = $<HTMLButtonElement>(".mic"),
    camera = $<HTMLButtonElement>(".camera");
  const dot = $(".dot"),
    cursor = $(".cursor"),
    preview = $<HTMLVideoElement>(".cam"),
    discard = $<HTMLButtonElement>(".discard");
  const options = { microphone: true, camera: false };
  let recorder: Recorder | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let visible = false;
  const fromHud = (event: Event) => event.composedPath().includes(host);

  // The page's own cursor is hidden while recording; show a stand-in that is not captured.
  const follow = (event: PointerEvent) =>
    (cursor.style.transform = `translate(${event.clientX}px, ${event.clientY}px)`);

  function render(state: RecorderState) {
    const busy = state.phase === "starting" || state.phase === "saving";
    const recording = state.phase === "recording";
    dot.hidden = !recording;
    cursor.style.display = recording ? "block" : "none";
    preview.style.display = recording && state.camera ? "block" : "none";
    if (recording && state.camera && preview.srcObject !== state.camera) {
      preview.srcObject = state.camera;
      void preview.play().catch(() => {});
    }
    if (!recording) preview.srcObject = null;
    mic.hidden = camera.hidden = recording || busy;
    mic.className = `mic${options.microphone ? " on" : ""}`;
    camera.className = `camera${options.camera ? " on" : ""}`;
    mic.setAttribute("aria-pressed", String(options.microphone));
    camera.setAttribute("aria-pressed", String(options.camera));
    action.disabled = busy || !recorder;
    const retry = state.phase === "error" ? state.retry : undefined;
    action.textContent = recording
      ? "Stop"
      : retry
        ? "Save recording"
        : state.phase === "saved" || state.phase === "error"
          ? "Record again"
          : busy
            ? "…"
            : "Record";
    action.title = recording ? "Stop recording (Alt+Shift+R)" : "";
    discard.hidden = !retry;
    if (retry) mic.hidden = camera.hidden = true;
    status.className = `status${state.phase === "error" ? " error" : ""}`;
    clearInterval(ticker);
    if (recording) {
      const tick = () =>
        (status.textContent = `${clock(performance.now() - state.startedAt)} · ${innerWidth}×${innerHeight}`);
      tick();
      ticker = setInterval(tick, 250);
    } else if (state.phase === "saved") {
      const params = new URLSearchParams({ [STUDIO_PARAM]: "1", [TAKE_PARAM]: state.take.id });
      status.innerHTML = `Saved ${(state.take.source.durationMs / 1000).toFixed(1)} s · <a href="?${params}">Open take</a>`;
    } else
      status.textContent =
        state.phase === "error"
          ? state.message
          : state.phase === "starting"
            ? state.step
            : state.phase === "saving"
              ? "Saving…"
              : recorder
                ? `Ready · ${innerWidth}×${innerHeight}`
                : status.textContent;
  }

  async function connect() {
    // The studio's own pages navigate with full page loads, which would end the capture at the first click.
    if (new URLSearchParams(location.search).has(STUDIO_PARAM)) {
      status.className = "status error";
      status.textContent =
        "The recorder records your app, not the Flick studio. Open a page of your app (without ?flick=1) and press Alt+Shift+R there.";
      action.disabled = true;
      mic.hidden = camera.hidden = true;
      return;
    }
    const unsupported = isSupported();
    if (unsupported)
      return void ((status.textContent = unsupported), (status.className = "status error"), (action.disabled = true));
    status.textContent = "Connecting…";
    const daemon = await connectDaemon();
    if (daemon.problem) {
      status.className = "status error";
      status.textContent = daemon.problem.message;
      action.textContent = "Retry";
      action.disabled = false;
      return;
    }
    recorder = createRecorder(daemon.client, fromHud);
    recorder.subscribe(render);
    recorder.recoverInterrupted();
    render(recorder.state);
  }

  mic.onclick = () => ((options.microphone = !options.microphone), recorder && render(recorder.state));
  camera.onclick = () => ((options.camera = !options.camera), recorder && render(recorder.state));
  action.onclick = () => {
    if (!recorder) return void connect();
    if (recorder.state.phase === "recording") return void recorder.stop();
    if (recorder.state.phase === "error" && recorder.state.retry) return void recorder.state.retry();
    recorder.reset();
    void recorder.start(options);
  };
  discard.onclick = () => recorder?.reset();
  $(".close").onclick = () => hud.close();

  const hud: RecorderHud = {
    open() {
      if (visible) return;
      visible = true;
      // <html> is the parent on purpose: the capture is restricted to <body>.
      document.documentElement.append(host);
      addEventListener("pointermove", follow, { capture: true, passive: true });
      if (!recorder) void connect();
    },
    close() {
      if (!visible || recorder?.state.phase === "recording" || recorder?.state.phase === "saving") return;
      visible = false;
      removeEventListener("pointermove", follow, { capture: true });
      host.remove();
    },
    /** The shortcut: stops a running recording, otherwise shows or hides the controls. */
    toggle() {
      if (recorder?.state.phase === "recording") return void recorder.stop();
      if (visible) hud.close();
      else hud.open();
    },
    get recorder() {
      return recorder;
    },
  };
  return (mounted = hud);
}
