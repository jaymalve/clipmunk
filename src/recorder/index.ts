import { hasInterruptedRecording } from "./capture";
import { adoptDaemonLink } from "./daemon";
import { mountRecorderHud } from "./hud";

export { createRecorder, isSupported, type Recorder, type RecorderOptions, type RecorderState } from "./capture";
export {
  adoptDaemonLink,
  connectDaemon,
  createDaemonClient,
  type DaemonClient,
  type DaemonLink,
  type DaemonProblem,
  type DaemonStatus,
  storedLink,
} from "./daemon";
export { mountRecorderHud, type RecorderHud } from "./hud";

export const RECORD_PARAM = "clipmunk-record";
let booted = false;

/** Called once by the generated dev-only adapter on every page of the app.
 * It remembers the daemon link if this page was opened with one, and makes the recorder
 * reachable: Alt+Shift+R toggles it (and stops a running recording), and `?clipmunk-record=1` opens it straight away.
 */
export function bootRecorder(): void {
  if (booted || typeof window === "undefined") return;
  booted = true;
  adoptDaemonLink();
  addEventListener("keydown", (event) => {
    if (event.altKey && event.shiftKey && event.code === "KeyR") {
      event.preventDefault();
      mountRecorderHud().toggle();
    }
  });
  // Reopen by itself after a reload cut a recording short, so the captured part can be saved.
  if (new URLSearchParams(location.search).has(RECORD_PARAM) || hasInterruptedRecording()) mountRecorderHud().open();
}
