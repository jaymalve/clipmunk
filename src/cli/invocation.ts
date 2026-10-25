import { parseArgs } from "node:util";
import type { Issue, Result } from "../core";

/** What every command receives: the parsed command line, where output goes, and one way to
 * print a result. `--json` prints the result object and nothing else; otherwise `format`
 * turns it into text. Both come from the same result, so they cannot disagree.
 */
export type Io = {
  cwd: string;
  out(text: string): void;
  err(text: string): void;
  signal?: AbortSignal;
  version: string;
};

export const OPTIONS = {
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  adapter: { type: "string" },
  scene: { type: "string" },
  take: { type: "string" },
  sequence: { type: "string" },
  seed: { type: "string" },
  seconds: { type: "string" },
  write: { type: "boolean" },
  url: { type: "string" },
  time: { type: "string" },
  fps: { type: "string" },
  size: { type: "string" },
  output: { type: "string", short: "o" },
  draft: { type: "boolean" },
  workers: { type: "string" },
  format: { type: "string" },
  ratio: { type: "string" },
  preset: { type: "string" },
  variant: { type: "string" },
  "poster-at": { type: "string" },
  port: { type: "string" },
  "no-launch": { type: "boolean" },
  fields: { type: "string" },
  replace: { type: "boolean" },
  title: { type: "string" },
} as const;

type Parsed = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;
export type Invocation = {
  io: Io;
  values: Parsed["values"];
  /** Words after the command name. */
  args: string[];
  context: { root: string; signal?: AbortSignal };
  /** False under `--json`: no progress lines, no opening a browser. */
  human: boolean;
  /** Print a result and return the exit code: 0 when it is ok, 1 otherwise. */
  print<T>(result: Result<T>, format: (data: T) => string): number;
  /** Print a mistake in how the command was called. */
  usage(message: string): number;
};
export type Command = (invocation: Invocation) => Promise<number> | number;

export const formatIssues = (issues: Issue[]) =>
  issues.map((issue) => `  ${issue.path ? `${issue.path}: ` : ""}${issue.message}`).join("\n");
export const number = (value: string | undefined) => (value === undefined ? undefined : Number(value));
export const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

export function parse(argv: string[]) {
  return parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
}

export function invocation(io: Io, values: Parsed["values"], args: string[]): Invocation {
  const human = !values.json;
  const print = <T>(result: Result<T>, format: (data: T) => string): number => {
    if (!human) io.out(JSON.stringify(result, null, 2));
    else if (result.ok) io.out(format(result.data));
    else io.err(formatIssues(result.issues));
    return result.ok ? 0 : 1;
  };
  return {
    io,
    values,
    args,
    context: { root: io.cwd, signal: io.signal },
    human,
    print,
    usage: (message) => print({ ok: false, issues: [{ code: "usage", message }] }, String),
  };
}
