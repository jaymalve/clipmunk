import type { JobEvent } from "./jobs";

/** What the Studio hears on `GET /v1/events`, one server-sent event each: a take was recorded,
 * a clip's edit changed (from the Studio, the CLI through the daemon, or an agent), the config
 * file changed on disk, a job made progress, the chat with the agent changed, or a clip became
 * out of date (or up to date) with its sources.
 */
export type StudioEvent =
  | { type: "take"; id: string }
  | { type: "edit"; kind: "take" | "scene" | "sequence"; id: string }
  | { type: "config" }
  | { type: "chat" }
  | { type: "stale" }
  | { type: "job"; job: string; kind: string; event: JobEvent; [key: string]: unknown };

export function createEvents() {
  const listeners = new Set<(event: StudioEvent) => void>();
  return {
    emit(event: StudioEvent) {
      for (const listener of [...listeners]) listener(event);
    },
    subscribe(listener: (event: StudioEvent) => void): () => void {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    get listening() {
      return listeners.size;
    },
  };
}
export type Events = ReturnType<typeof createEvents>;
