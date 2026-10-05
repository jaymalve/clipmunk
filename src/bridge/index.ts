/** The contract between a page that can be rendered and the exporter that drives it.
 * A page exposes exactly one bridge on window.__FLICK__. Preview and export call the
 * same seek, so they cannot disagree about what a frame looks like.
 */
export interface FlickBridge {
  version: 1;
  kind: "scene" | "take";
  /** Presentation length. Zero means a still. */
  durationMs: number;
  /** Authored frame size in CSS pixels. */
  width: number;
  height: number;
  /** The element to capture, for DOM clips. */
  selector: string;
  /** Resolves when fonts, images and layout are settled. */
  ready(): Promise<void>;
  /** Resolves when the frame at `timeMs` is fully applied. Rejects if the clip has unresolved issues. */
  seek(timeMs: number): Promise<void>;
}

export const BRIDGE_KEY = "__FLICK__";
export const CAPTURE_SELECTOR = '[data-flick-capture="scene"]';
/** Studio UI carries this attribute; the exporter hides it in its own page only. */
export const CHROME_SELECTOR = "[data-flick-chrome]";

type BridgeHost = { [BRIDGE_KEY]?: FlickBridge };

export function installBridge(bridge: FlickBridge): () => void {
  const host = window as unknown as BridgeHost;
  if (host[BRIDGE_KEY]) throw new Error("Only one Flick clip can be open per page.");
  host[BRIDGE_KEY] = bridge;
  return () => {
    if (host[BRIDGE_KEY] === bridge) delete host[BRIDGE_KEY];
  };
}
