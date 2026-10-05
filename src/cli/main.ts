import { run } from "./run";

declare const __FLICK_VERSION__: string;

const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => controller.abort());

run(process.argv.slice(2), {
  cwd: process.cwd(),
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
  signal: controller.signal,
  version: typeof __FLICK_VERSION__ === "string" ? __FLICK_VERSION__ : "0.0.0-dev",
}).then(
  (code) => (process.exitCode = code),
  (error) => {
    process.stderr.write(`flick failed unexpectedly: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  },
);
