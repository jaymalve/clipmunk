import { randomBytes } from "node:crypto";
import type { Issue, Result } from "../core";

/** Long-running work started by the studio. Each job keeps its events so a listener that
 * connects late still sees the latest progress and the outcome.
 */
export type JobEvent =
  | { type: "progress"; done: number; total: number }
  | { type: "done"; data: unknown }
  | { type: "failed"; issues: Issue[] };
type Job = {
  id: string;
  kind: string;
  last?: JobEvent;
  finished: boolean;
  listeners: Set<(event: JobEvent) => void>;
  controller: AbortController;
};

export function createJobs(onEvent?: (job: { id: string; kind: string }, event: JobEvent) => void) {
  const jobs = new Map<string, Job>();
  const emit = (job: Job, event: JobEvent) => {
    job.last = event;
    if (event.type !== "progress") job.finished = true;
    for (const listener of [...job.listeners]) listener(event);
    onEvent?.(job, event);
  };
  return {
    start<T>(
      kind: string,
      work: (signal: AbortSignal, progress: (done: number, total: number) => void) => Promise<Result<T>>,
    ): string {
      const job: Job = {
        id: randomBytes(8).toString("hex"),
        kind,
        finished: false,
        listeners: new Set(),
        controller: new AbortController(),
      };
      jobs.set(job.id, job);
      work(job.controller.signal, (done, total) => emit(job, { type: "progress", done, total })).then(
        (result) =>
          emit(job, result.ok ? { type: "done", data: result.data } : { type: "failed", issues: result.issues }),
        (error: unknown) =>
          emit(job, {
            type: "failed",
            issues: [{ code: "job-failed", message: error instanceof Error ? error.message : String(error) }],
          }),
      );
      return job.id;
    },
    /** Replays the latest event, then streams the rest. Returns undefined for an unknown job. */
    subscribe(id: string, listener: (event: JobEvent) => void): (() => void) | undefined {
      const job = jobs.get(id);
      if (!job) return undefined;
      if (job.last) listener(job.last);
      if (job.finished) return () => {};
      job.listeners.add(listener);
      return () => void job.listeners.delete(listener);
    },
    cancel(id: string): boolean {
      const job = jobs.get(id);
      if (!job) return false;
      job.controller.abort();
      return true;
    },
    cancelAll() {
      for (const job of jobs.values()) job.controller.abort();
    },
  };
}
export type Jobs = ReturnType<typeof createJobs>;
