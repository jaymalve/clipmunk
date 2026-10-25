import type { DaemonClient } from "../recorder";

/** One stream of the daemon's events per page, shared by every part of the Studio that listens.
 * Browsers allow only a few connections to one address, and each open stream holds one.
 */
type Listener = (event: { type: string; [key: string]: unknown }) => void;
let shared: { source: EventSource; listeners: Set<Listener> } | undefined;

export function onStudioEvent(client: DaemonClient, listener: Listener): () => void {
  if (!shared) {
    const source = new EventSource(client.url("/v1/events"));
    const listeners = new Set<Listener>();
    source.onmessage = (message) => {
      const event = JSON.parse(message.data as string);
      for (const each of [...listeners]) each(event);
    };
    shared = { source, listeners };
  }
  const current = shared;
  current.listeners.add(listener);
  return () => {
    current.listeners.delete(listener);
    if (!current.listeners.size && shared === current) {
      current.source.close();
      shared = undefined;
    }
  };
}
