import type { z } from "zod";

/** Every operation returns a Result; expected failures are data, not exceptions. */
export type Issue = { code: string; path?: string; message: string };
export type Result<T> = { ok: true; data: T } | { ok: false; issues: Issue[] };

export const ok = <T>(data: T): Result<T> => ({ ok: true, data });
export const fail = (issues: Issue[]): Result<never> => ({ ok: false, issues });

export function zodIssues(error: z.ZodError, code: string): Issue[] {
  return error.issues.map((issue) => ({ code, path: issue.path.join("."), message: issue.message }));
}
