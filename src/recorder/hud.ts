import { FRAME_PARAM, STUDIO_PARAM, TAKE_PARAM } from "../core";
import { createRecorder, isSupported, type Recorder, type RecorderState } from "./capture";
import { connectDaemon, storedLink } from "./daemon";

/** The recorder's on-page controls. It is a custom element appended to <html>, outside
 * <body>, so the restricted capture never includes it. Everything is plain DOM in a
 * shadow root: the recorder works in any web app, with or without React.
 */
const TAG = "clipmunk-recorder";
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

/** The controls' DOM, built once. Nothing here changes after it is created except through `paint`. */
function buildHud() {
  const host = document.createElement(TAG);
  host.setAttribute("data-clipmunk-chrome", "");
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>${STYLES}</style><div class="cursor">${ARROW}</div><video class="cam" muted playsinline></video>
    <div class="bar" role="toolbar" aria-label="Clipmunk recorder">
      <span class="dot" hidden></span><span class="status"></span>
      <button class="mic" type="button" aria-pressed="true">Mic</button><button class="camera" type="button" aria-pressed="false">Camera</button>
      <button class="discard" type="button" hidden>Discard</button><button class="primary action" type="button">Record</button><button class="ghost close" type="button" aria-label="Close recorder">✕</button>
    </div>`;
  const $ = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  return {
    host,
    status: $(".status"),
    dot: $(".dot"),
    cursor: $(".cursor"),
    preview: $<HTMLVideoElement>(".cam"),
    action: $<HTMLButtonElement>(".action"),
    mic: $<HTMLButtonElement>(".mic"),
    camera: $<HTMLButtonElement>(".camera"),
    discard: $<HTMLButtonElement>(".discard"),
    close: $<HTMLButtonElement>(".close"),
  };
}
type Parts = ReturnType<typeof buildHud>;
type Choices = { microphone: boolean; camera: boolean };

function actionLabel(state: RecorderState): string {
  if (state.phase === "recording") return "Stop";
  if (state.phase === "error") return state.retry ? "Save recording" : "Record again";
  if (state.phase === "saved") return "Record again";
  return state.phase === "idle" ? "Record" : "…";
}

/** Write the status line. While recording it is a running clock; the returned timer keeps it going. */
function paintStatus(status: HTMLElement, state: RecorderState): ReturnType<typeof setInterval> | undefined {
  status.className = `status${state.phase === "error" ? " error" : ""}`;
  if (state.phase === "recording") {
    const tick = () =>
      (status.textContent = `${clock(performance.now() - state.startedAt)} · ${innerWidth}×${innerHeight}`);
    tick();
    return setInterval(tick, 250);
  }
  if (state.phase === "saved") {
    // The take opens in the standalone Studio, served by the daemon that saved it.
    const params = new URLSearchParams({ [STUDIO_PARAM]: "1", [TAKE_PARAM]: state.take.id });
    const link = storedLink();
    const href = link ? `http://127.0.0.1:${link.port}/?${params}` : `?${params}`;
    status.innerHTML = `Saved ${(state.take.source.durationMs / 1000).toFixed(1)} s · <a href="${href}" target="_blank" rel="noopener">Open in Studio</a>`;
  } else if (state.phase === "error") status.textContent = state.message;
  else if (state.phase === "starting") status.textContent = state.step;
  else status.textContent = state.phase === "saving" ? "Saving…" : `Ready · ${innerWidth}×${innerHeight}`;
  return undefined;
}

/** Show the camera's picture while recording, as it will sit in the take. */
function paintPreview(preview: HTMLVideoElement, state: RecorderState) {
  const stream = state.phase === "recording" ? state.camera : undefined;
  preview.style.display = stream ? "block" : "none";
  if (stream && preview.srcObject !== stream) {
    preview.srcObject = stream;
    void preview.play().catch(() => {});
  }
  if (state.phase !== "recording") preview.srcObject = null;
}

/** Make the buttons match the recorder's state and the chosen microphone and camera. */
function paintButtons(parts: Parts, state: RecorderState, choices: Choices) {
  const { mic, camera, action, discard } = parts;
  const busy = state.phase === "starting" || state.phase === "saving";
  const recording = state.phase === "recording";
  const retry = state.phase === "error" && !!state.retry;
  mic.hidden = camera.hidden = recording || busy || retry;
  mic.className = `mic${choices.microphone ? " on" : ""}`;
  camera.className = `camera${choices.camera ? " on" : ""}`;
  mic.setAttribute("aria-pressed", String(choices.microphone));
  camera.setAttribute("aria-pressed", String(choices.camera));
  action.disabled = busy;
  action.textContent = actionLabel(state);
  action.title = recording ? "Stop recording (Alt+Shift+R)" : "";
  discard.hidden = !retry;
}

/** Say why recording cannot start here. `retry` leaves the main button usable as "Retry". */
function paintProblem(parts: Parts, message: string, retry = false) {
  parts.status.className = "status error";
  parts.status.textContent = message;
  parts.action.disabled = !retry;
  if (retry) parts.action.textContent = "Retry";
}

export function mountRecorderHud(): RecorderHud {
  if (mounted) return mounted;
  const parts = buildHud();
  const { host, cursor } = parts;
  const choices: Choices = { microphone: true, camera: false };
  let recorder: Recorder | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let visible = false;
  const fromHud = (event: Event) => event.composedPath().includes(host);

  // The page's own cursor is hidden while recording; show a stand-in that is not captured.
  const follow = (event: PointerEvent) =>
    (cursor.style.transform = `translate(${event.clientX}px, ${event.clientY}px)`);

  function render(state: RecorderState) {
    const recording = state.phase === "recording";
    parts.dot.hidden = !recording;
    cursor.style.display = recording ? "block" : "none";
    paintPreview(parts.preview, state);
    paintButtons(parts, state, choices);
    clearInterval(ticker);
    ticker = paintStatus(parts.status, state);
  }

  async function connect() {
    // The studio's own pages navigate with full page loads, which would end the capture at the first click.
    const params = new URLSearchParams(location.search);
    if (params.has(STUDIO_PARAM) || params.has(FRAME_PARAM)) {
      parts.mic.hidden = parts.camera.hidden = true;
      return paintProblem(
        parts,
        "The recorder records your app, not the Clipmunk studio. Open a page of your app (without ?clipmunk=1) and press Alt+Shift+R there.",
      );
    }
    const unsupported = isSupported();
    if (unsupported) return paintProblem(parts, unsupported);
    parts.status.textContent = "Connecting…";
    const daemon = await connectDaemon();
    if (daemon.problem) return paintProblem(parts, daemon.problem.message, true);
    recorder = createRecorder(daemon.client, fromHud);
    recorder.subscribe(render);
    recorder.recoverInterrupted();
    render(recorder.state);
  }

  const toggle = (choice: keyof Choices) => () => {
    choices[choice] = !choices[choice];
    if (recorder) render(recorder.state);
  };
  parts.mic.onclick = toggle("microphone");
  parts.camera.onclick = toggle("camera");
  parts.action.onclick = () => {
    if (!recorder) return void connect();
    if (recorder.state.phase === "recording") return void recorder.stop();
    if (recorder.state.phase === "error" && recorder.state.retry) return void recorder.state.retry();
    recorder.reset();
    void recorder.start(choices);
  };
  parts.discard.onclick = () => recorder?.reset();
  parts.close.onclick = () => hud.close();

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
  mounted = hud;
  return hud;
}
