// Installs the packed package into a fresh host app and walks the whole path an agent takes:
// init -> author a scene -> validate -> snapshot -> export -> production build without Clipmunk.
// Run: node scripts/check-installed.mjs [vite] [next]     (needs network for npm, and FFmpeg)
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const repo = path.resolve(new URL("..", import.meta.url).pathname);
const env = {
  ...process.env,
  CLIPMUNK_FFMPEG: process.env.CLIPMUNK_FFMPEG ?? path.join(repo, "node_modules/ffmpeg-static/ffmpeg"),
  NEXT_TELEMETRY_DISABLED: "1",
};
const sh = (cwd, command, args, options = {}) =>
  execFileSync(command, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
const check = (condition, message) => {
  if (!condition) throw new Error(`CHECK FAILED: ${message}`);
  console.log(`  ok  ${message}`);
};
const write = (root, files) => {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), content);
  }
};
const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name);
    return statSync(file).isDirectory() ? walk(file) : [file];
  });

const CARD = `export function Card() {
  return (
    <div style={{ width: 420, padding: 28, borderRadius: 18, background: "#fff", color: "#0f172a", font: "16px system-ui" }}>
      <small style={{ color: "#64748b" }}>Revenue</small>
      <b style={{ display: "block", fontSize: 44 }}>$84,210</b>
      <span style={{ color: "#059669" }}>+12.4% this week</span>
    </div>
  );
}
`;
const scene = (componentImport) => ({
  "src/clipmunk/scenes/card-pass.scene.json": JSON.stringify(
    {
      version: 1,
      id: "card-pass",
      title: "Card pass",
      definition: {
        width: 700,
        height: 420,
        scene: {
          camera: { perspective: 1200 },
          focus: { distance: 1300, fStop: 2, focalLength: 100, maxBlur: 4 },
          nodes: [{ id: "card", transform: { z: -100 } }],
        },
        motion: {
          durationMs: 1000,
          tracks: [
            {
              target: { kind: "camera" },
              property: "x",
              keyframes: [
                { timeMs: 0, value: -60 },
                { timeMs: 1000, value: 60 },
              ],
            },
          ],
        },
      },
    },
    null,
    2,
  ),
  "src/clipmunk/scenes/card-pass.tsx": `import { Surface } from "clipmunk";\nimport { Card } from "${componentImport}";\n\nexport default function CardPass() {\n  return (\n    <div style={{ display: "grid", placeItems: "center", width: 700, height: 420 }}>\n      <Surface id="card"><Card /></Surface>\n    </div>\n  );\n}\n`,
});

const HOSTS = {
  vite: {
    port: 5311,
    dependencies: { react: "^19", "react-dom": "^19" },
    devDependencies: {
      vite: "^8",
      "@vitejs/plugin-react": "^6",
      typescript: "^5",
      "@types/react": "^19",
      "@types/react-dom": "^19",
    },
    files: {
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          jsx: "react-jsx",
          strict: true,
          noEmit: true,
          resolveJsonModule: true,
          skipLibCheck: true,
          types: ["vite/client"],
        },
        include: ["src"],
      }),
      // clipmunk/vite marks elements with their source file in dev only; the build check below proves it.
      "vite.config.ts": `import react from "@vitejs/plugin-react";\nimport { clipmunk } from "clipmunk/vite";\nimport { defineConfig } from "vite";\nexport default defineConfig({ plugins: [react(), clipmunk()] });\n`,
      "index.html": `<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>`,
      "src/main.tsx": `import { StrictMode } from "react";\nimport { createRoot } from "react-dom/client";\nimport { App } from "./App";\n\ncreateRoot(document.getElementById("root")!).render(\n  <StrictMode>\n    <App />\n  </StrictMode>,\n);\n`,
      "src/App.tsx": `import { Card } from "./Card";\nexport function App() { return <main><h1>Host app</h1><Card /></main>; }\n`,
      "src/Card.tsx": CARD,
    },
    cardImport: "../../Card",
    // A module as the dev server sends it, with its host elements marked.
    tagged: { url: "/src/Card.tsx", file: "src/Card.tsx" },
    dev: ["npx", ["vite", "--host", "127.0.0.1", "--port", "5311", "--strictPort"]],
    build: ["npx", ["vite", "build"]],
    output: "dist",
    expectAdapter: "vite",
    typecheck: true,
  },
  next: {
    port: 3111,
    dependencies: { next: "^16", react: "^19", "react-dom": "^19" },
    devDependencies: { typescript: "^5", "@types/react": "^19", "@types/react-dom": "^19", "@types/node": "^22" },
    files: {
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          lib: ["dom", "dom.iterable", "esnext"],
          module: "esnext",
          moduleResolution: "bundler",
          jsx: "preserve",
          strict: true,
          noEmit: true,
          resolveJsonModule: true,
          isolatedModules: true,
          esModuleInterop: true,
          skipLibCheck: true,
          incremental: true,
          plugins: [{ name: "next" }],
        },
        include: ["next-env.d.ts", "**/*.ts", "**/*.tsx"],
        exclude: ["node_modules"],
      }),
      "app/layout.tsx": `export default function RootLayout({ children }: { children: React.ReactNode }) {\n  return <html lang="en"><body>{children}</body></html>;\n}\n`,
      "app/page.tsx": `import { Card } from "../components/Card";\nexport default function Home() { return <main><h1>Host app</h1><Card /></main>; }\n`,
      "components/Card.tsx": CARD,
      "next.config.mjs": `import { withClipmunk } from "clipmunk/next";\nexport default withClipmunk({});\n`,
    },
    cardImport: "../../../components/Card",
    dev: ["npx", ["next", "dev", "--hostname", "127.0.0.1", "--port", "3111"]],
    build: ["npx", ["next", "build"]],
    output: ".next/static",
    expectAdapter: "next-app",
    typecheck: false, // next build type-checks the project itself
  },
};

async function waitFor(url, child, log) {
  for (let i = 0; i < 180; i++) {
    if (child.exitCode !== null) throw new Error(`dev server exited:\n${log()}`);
    if (
      await fetch(url).then(
        (r) => r.status < 500,
        () => false,
      )
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`dev server never answered at ${url}:\n${log()}`);
}

async function stopGroup(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const timer = setTimeout(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }, 5000);
  await exited;
  clearTimeout(timer);
}

async function checkHost(name, tarball) {
  const host = HOSTS[name];
  const root = mkdtempSync(path.join(os.tmpdir(), `clipmunk-installed-${name}-`));
  const clipmunk = (...args) => sh(root, "npx", ["clipmunk", ...args]);
  const origin = `http://127.0.0.1:${host.port}`;
  let server,
    serverLog = "";
  console.log(`\n${name}: ${root}`);
  try {
    write(root, {
      "package.json": JSON.stringify(
        {
          name: `host-${name}`,
          private: true,
          type: name === "vite" ? "module" : undefined,
          dependencies: host.dependencies,
          devDependencies: host.devDependencies,
        },
        null,
        2,
      ),
      ...host.files,
    });
    sh(root, "npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"]);
    sh(root, "npm", [
      "install",
      "--no-audit",
      "--no-fund",
      "--loglevel=error",
      tarball,
      "-D",
      `playwright@${JSON.parse(readFileSync(path.join(repo, "node_modules/playwright/package.json"), "utf8")).version}`,
    ]);
    check(existsSync(path.join(root, "node_modules/.bin/clipmunk")), "the clipmunk binary is installed");

    const init = JSON.parse(clipmunk("init", "--json"));
    check(init.ok && init.data.adapter === host.expectAdapter, `init detects ${host.expectAdapter}`);
    check(
      ["wrapped", "route"].includes(init.data.entry.status),
      `init connects the host automatically (${init.data.entry.status})`,
    );
    check(
      JSON.parse(clipmunk("guide", "--json")).example.recipe.id === "page-survey",
      "the installed guide prints its tested example",
    );
    write(root, scene(host.cardImport));
    if (name !== "vite")
      check(JSON.parse(clipmunk("sync", "--json")).data.scenes === 1, "sync adds the new scene to the catalog");
    const generated = () =>
      walk(path.join(root, "src/clipmunk"))
        .filter((file) => !file.includes(`${path.sep}scenes${path.sep}`))
        .map((file) => `${file}\n${readFileSync(file, "utf8")}`)
        .join("\n");
    const before = generated();
    const scenes = JSON.parse(clipmunk("scenes", "--json"));
    check(
      scenes.ok && scenes.data.scenes.length === 1 && scenes.data.issues.length === 0,
      "the authored scene validates",
    );
    if (host.typecheck) {
      sh(root, "npx", ["tsc", "--noEmit"]);
      check(true, "the host type-checks with the generated files and the scene");
    }

    // A server left over from an interrupted run would answer for a directory that no longer exists.
    if (
      await fetch(origin).then(
        () => true,
        () => false,
      )
    )
      throw new Error(`Port ${host.port} is already in use. Stop whatever is listening there and run this again.`);
    // Own process group, so stopping it also stops the server that npx starts underneath.
    server = spawn(host.dev[0], host.dev[1], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    for (const stream of [server.stdout, server.stderr])
      stream.on("data", (chunk) => (serverLog = (serverLog + chunk).slice(-3000)));
    await waitFor(origin, server, () => serverLog);
    const home = await fetch(origin).then((response) => response.text());
    check(
      !/clipmunk/i.test(home.replace(/host-\w+/g, "")) || name === "next",
      "the normal page is served without the studio",
    );
    // Next 16's dev server is Turbopack, which clipmunk/next leaves alone (webpack dev is tagged).
    if (host.tagged) {
      const module = await fetch(`${origin}${host.tagged.url}`).then((response) => response.text());
      check(
        module.includes(`"data-clipmunk-src": ${JSON.stringify(host.tagged.file)}`),
        "in development, elements carry the file that rendered them",
      );
    }

    const snapshot = JSON.parse(clipmunk("snapshot", "--scene", "card-pass", "--url", origin, "--json"));
    check(snapshot.ok, `snapshot saves a thumbnail${snapshot.ok ? "" : `: ${JSON.stringify(snapshot.issues)}`}`);
    check(
      JSON.parse(
        readFileSync(path.join(root, "src/clipmunk/scenes/card-pass.scene.json"), "utf8"),
      ).snapshot.image.startsWith("data:image/png"),
      "the recipe now carries the snapshot",
    );
    const exported = JSON.parse(clipmunk("export", "--scene", "card-pass", "--fps", "30", "--workers", "1", "--json"));
    check(exported.ok, `export renders an MP4${exported.ok ? "" : `: ${JSON.stringify(exported.issues)}`}`);
    const stderr = spawnSyncStderr(root, exported.data.output);
    check(/frame=\s*30\b/.test(stderr) && /700x420/.test(stderr), "the MP4 has 30 frames at 700x420");
    const manifest = JSON.parse(readFileSync(path.join(root, ".clipmunk/manifest.json"), "utf8"));
    const sources = Object.keys(manifest.clips["scene:card-pass"]?.files ?? {});
    check(
      sources.includes("src/clipmunk/scenes/card-pass.scene.json") && sources.some((file) => file.endsWith("Card.tsx")),
      "the export manifest lists the scene's files and the component it imports",
    );

    // The daemon starts from the installed binary, answers with its token, and cleans up when stopped.
    // Started directly so the interrupt reaches it, as Ctrl+C in a terminal does.
    const dev = spawn(path.join(root, "node_modules/.bin/clipmunk"), ["dev", "--port", "0", "--json"], {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const started = JSON.parse(
      await new Promise((resolve, reject) => {
        dev.stdout.once("data", (chunk) => resolve(String(chunk)));
        dev.once("exit", () => reject(new Error("clipmunk dev exited early")));
      }),
    );
    if (!started.ok) throw new Error(`clipmunk dev did not start: ${JSON.stringify(started.issues)}`);
    const daemonStatus = await fetch(`http://127.0.0.1:${started.data.port}/v1/status`, {
      headers: { authorization: `Bearer ${started.data.token}` },
    }).then((response) => response.json());
    check(daemonStatus.ok && daemonStatus.data.ffmpeg, "clipmunk dev starts the daemon and it sees FFmpeg");
    // The standalone Studio ships in the package and the daemon serves it at its printed link.
    const studioPage = await fetch(`http://127.0.0.1:${started.data.port}/`);
    check(
      studioPage.ok && (await studioPage.text()).includes("<title>Clipmunk Studio</title>") && started.data.studio,
      "the Studio opens from clipmunk dev",
    );
    check(
      (await fetch(`http://127.0.0.1:${started.data.port}/v1/status`)).status === 401,
      "the daemon refuses requests without the token",
    );
    dev.kill("SIGINT");
    await new Promise((resolve) => dev.once("exit", resolve));
    check(!existsSync(path.join(root, ".clipmunk/daemon.json")), "stopping the daemon removes its address file");
    check(
      JSON.parse(clipmunk("takes", "--json")).data.takes.length === 0,
      "takes lists nothing before the first recording",
    );

    const again = JSON.parse(clipmunk("init", "--json"));
    check(
      again.ok && again.data.files.every((file) => file.status === "verified"),
      "running init again changes nothing",
    );
    check(before.length > 200 && generated() === before, "generated files are byte-for-byte unchanged");

    await stopGroup(server);
    server = undefined;
    sh(root, host.build[0], host.build[1]);
    const shipped = walk(path.join(root, host.output))
      .filter((file) => /\.(js|html|css)$/.test(file))
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    check(
      shipped.length > 1000 && !/data-clipmunk|ClipmunkStudio|clipmunk-scene/.test(shipped),
      "the production build contains no Clipmunk code",
    );
    return true;
  } finally {
    if (server) await stopGroup(server);
    if (!process.env.CLIPMUNK_KEEP) rmSync(root, { recursive: true, force: true });
  }
}

function spawnSyncStderr(cwd, file) {
  return spawnSync(env.CLIPMUNK_FFMPEG, ["-hide_banner", "-i", file, "-map", "0:v:0", "-f", "null", "-"], {
    cwd,
    encoding: "utf8",
  }).stderr;
}

sh(repo, "node", ["scripts/build.mjs"]);
const packDir = mkdtempSync(path.join(os.tmpdir(), "clipmunk-pack-"));
const tarball = path.join(
  packDir,
  sh(repo, "npm", ["pack", "--pack-destination", packDir, "--loglevel=error"]).trim().split("\n").pop(),
);
console.log(`packed ${path.basename(tarball)} (${Math.round(statSync(tarball).size / 1024)} kB)`);
const selected = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(HOSTS);
try {
  for (const name of selected) await checkHost(name, tarball);
  console.log("\nInstalled-package checks passed.");
} finally {
  rmSync(packDir, { recursive: true, force: true });
}
