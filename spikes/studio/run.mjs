// Spike: one command that starts the host app, the shell and a daemon, runs the checks, and stops them.
//   node spikes/studio/run.mjs              the two open questions, on page-survey, headed, DPR 2
//   ONLY=scrub,play,pair,pixels,picker,take,hmr node spikes/studio/run.mjs   everything
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const app = `${repo}examples/vite-app`;
if (!existsSync(`${repo}dist/cli.js`)) {
  console.error("Build the package first: npm run build");
  process.exit(1);
}
const children = [];
const start = (args, cwd, ready) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Timed out starting ${args.join(" ")}:\n${output}`)), 60_000);
    const on = (chunk) => {
      output += chunk;
      const match = ready(output);
      if (match) { clearTimeout(timer); resolve(match); }
    };
    child.stdout.on("data", on);
    child.stderr.on("data", on);
    child.on("exit", (code) => reject(new Error(`${args.join(" ")} exited with ${code}:\n${output}`)));
  });
const stop = () => { for (const child of children) child.kill(); };
process.on("SIGINT", () => { stop(); process.exit(130); });

try {
  const vite = `${repo}node_modules/vite/bin/vite.js`;
  await Promise.all([
    start([vite, "--config", "spikes/studio/host.config.ts"], repo, (o) => o.includes("5180")),
    start([vite, "--config", "spikes/studio/shell.config.ts"], repo, (o) => o.includes("4800")),
  ]);
  // Port 0: never collides with a daemon you already have running.
  const daemon = await start([`${repo}dist/cli.js`, "dev", "--json", "--port", "0"], app, (o) => {
    const line = o.split("\n").find((l) => l.startsWith("{"));
    return line && JSON.stringify(JSON.parse(line).data);
  });
  const env = {
    SCENE: "page-survey",
    ONLY: "scrub,play,pair",
    DPR: "2",
    HEADED: "1",
    LABEL: "mac",
    MACHINE: "mac",
    ...process.env,
    DAEMON: daemon,
  };
  console.log(`Measuring ${env.SCENE} (${env.ONLY}) at DPR ${env.DPR}${env.HEADED ? ", headed" : ""}. Leave the browser window alone and on screen.`);
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, ["spikes/studio/measure.mjs"], { cwd: repo, env, stdio: "inherit" });
    child.on("exit", resolve);
  });
  console.log(code === 0 ? `\nSaved spikes/studio/results-${env.LABEL}-${env.SCENE}.json` : `\nmeasure.mjs failed (${code})`);
  stop();
  process.exit(code ?? 1);
} catch (error) {
  console.error(error.message);
  stop();
  process.exit(1);
}
