import { run } from "./run";

declare const __CLIPMUNK_VERSION__: string;

const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => controller.abort());

run(process.argv.slice(2), {
  cwd: process.cwd(),
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
  signal: controller.signal,
  version: typeof __CLIPMUNK_VERSION__ === "string" ? __CLIPMUNK_VERSION__ : "0.0.0-dev",
}).then(
  (code) => (process.exitCode = code),
  (error) => {
    process.stderr.write(`clipmunk failed unexpectedly: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  },
);
