import type { JobEvent } from "./jobs";

/** What the Studio hears on `GET /v1/events`, one server-sent event each: a take was recorded,
 * a clip's edit changed (from the Studio, the CLI through the daemon, or an agent), the config
 * file changed on disk, or a job made progress. Later features add their own kinds.
 */
export type StudioEvent =
  | { type: "take"; id: string }
  | { type: "edit"; kind: "take" | "scene" | "sequence"; id: string }
  | { type: "config" }
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
