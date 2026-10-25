import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getGuide } from "../core";
import { run } from "./run";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function host(files: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "clipmunk-cli-"));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
  return root;
}
async function clipmunk(cwd: string, ...args: string[]) {
  const out: string[] = [],
    err: string[] = [];
  const code = await run(args, { cwd, out: (text) => out.push(text), err: (text) => err.push(text), version: "9.9.9" });
  return { code, out: out.join("\n"), err: err.join("\n") };
}
const VITE = {
  "package.json": JSON.stringify({ dependencies: { react: "19", "react-dom": "19", vite: "8" } }),
  "src/main.jsx": 'createRoot(document.getElementById("root")).render(<App />);\n',
};

describe("clipmunk cli", () => {
  it("prints help, the version, and rejects unknown commands and flags", async () => {
    const cwd = await host();
    expect((await clipmunk(cwd, "--help")).out).toContain("clipmunk <command>");
    expect(await clipmunk(cwd, "--version")).toMatchObject({ code: 0, out: "9.9.9" });
    expect((await clipmunk(cwd)).code).toBe(1);
    expect(await clipmunk(cwd, "frobnicate")).toMatchObject({ code: 1 });
    expect((await clipmunk(cwd, "scenes", "--nope")).err).toContain("clipmunk <command>");
  });

  it("prints the guide as prose and as JSON", async () => {
    const cwd = await host();
    expect((await clipmunk(cwd, "guide")).out).toContain("# Clipmunk authoring guide");
    expect(JSON.parse((await clipmunk(cwd, "guide", "--json")).out)).toEqual(JSON.parse(JSON.stringify(getGuide())));
  });

  it("initialises a project and reports the same result in both formats", async () => {
    const cwd = await host(VITE);
    const human = await clipmunk(cwd, "init");
    expect(human.code).toBe(0);
    expect(human.out).toContain("Connected Clipmunk (vite).");
    expect(human.out).toContain("wrapped  src/main.jsx");
    const json = JSON.parse((await clipmunk(cwd, "init", "--json")).out);
    expect(json.ok && json.data.entry.status).toBe("already");
    expect(await clipmunk(cwd, "init", "--adapter", "angular")).toMatchObject({ code: 1 });
  });

  it("explains failures on stderr with a non-zero exit, and as a result object with --json", async () => {
    const cwd = await host();
    const human = await clipmunk(cwd, "init");
    expect(human).toMatchObject({ code: 1, out: "" });
    expect(human.err).toContain("No package.json here");
    const json = await clipmunk(cwd, "init", "--json");
    expect(json.code).toBe(1);
    expect(JSON.parse(json.out)).toMatchObject({ ok: false, issues: [{ code: "no-project" }] });
  });

  it("lists scenes and exits non-zero while any scene file is broken", async () => {
    const guide = getGuide();
    const cwd = await host({
      ...VITE,
      [guide.example.recipePath]: JSON.stringify(guide.example.recipe),
      [guide.example.componentPath]: guide.example.component,
    });
    expect(await clipmunk(cwd, "scenes")).toMatchObject({ code: 0 });
    expect((await clipmunk(cwd, "scenes")).out).toContain("page-survey");
    await writeFile(
      path.join(cwd, "src/clipmunk/scenes/half.scene.json"),
      JSON.stringify({ ...guide.example.recipe, id: "half" }),
    );
    const broken = await clipmunk(cwd, "scenes");
    expect(broken.code).toBe(1);
    expect(broken.out).toContain("needs a component next to it");
  });

  it("runs the daemon until interrupted and lists takes", async () => {
    const cwd = await host(VITE);
    expect((await clipmunk(cwd, "dev", "--port", "70000")).err).toContain("--port must be a port number");
    expect((await clipmunk(cwd, "takes")).out).toContain("No takes yet");
    expect((await clipmunk(cwd, "stale")).out).toContain("Nothing exported yet");
    expect(JSON.parse((await clipmunk(cwd, "stale", "--json")).out)).toMatchObject({ ok: true, data: { clips: [] } });
    const controller = new AbortController();
    const out: string[] = [];
    const running = run(["dev", "--port", "0", "--json"], {
      cwd,
      out: (text) => out.push(text),
      err: () => {},
      signal: controller.signal,
      version: "9.9.9",
    });
    await expect.poll(() => out.length).toBe(1);
    const { data } = JSON.parse(out[0]!) as { data: { port: number; token: string; link: string } };
    expect(data.link).toBe(`http://127.0.0.1:5173/?clipmunk=1#clipmunk-daemon=${data.port}.${data.token}`);
    const status = await fetch(`http://127.0.0.1:${data.port}/v1/status`, {
      headers: { authorization: `Bearer ${data.token}` },
    });
    expect(((await status.json()) as { data: { version: string } }).data.version).toBe("9.9.9");
    controller.abort();
    expect(await running).toBe(0);
    await expect(fetch(`http://127.0.0.1:${data.port}/v1/status`)).rejects.toThrow();
  });

  it("writes a sample of the generated music and will not overwrite one", async () => {
    const cwd = await host();
    expect((await clipmunk(cwd, "music")).err).toContain("music needs a style");
    expect((await clipmunk(cwd, "music", "jazz")).code).toBe(1);
    const made = await clipmunk(cwd, "music", "lofi", "--seed", "5", "--seconds", "2");
    expect(made.out).toContain("Wrote clipmunk-lofi-5.wav: lofi, seed 5, 2 s at 82 beats per minute");
    const wav = await readFile(path.join(cwd, "clipmunk-lofi-5.wav"));
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav.length).toBe(44 + 2 * 44100 * 4);
    expect((await clipmunk(cwd, "music", "lofi", "--seed", "5", "--seconds", "2")).err).toContain("already exists");
    expect((await clipmunk(cwd, "music", "lofi", "--output", "../outside.wav")).code).toBe(1);
  });

  it("asks for what is missing before rendering", async () => {
    const cwd = await host(VITE);
    expect((await clipmunk(cwd, "export")).err).toContain("export needs --scene");
    expect((await clipmunk(cwd, "snapshot", "--scene", "a")).err).toContain("npx clipmunk init");
    await clipmunk(cwd, "init");
    expect((await clipmunk(cwd, "export", "--scene", "a", "--size", "big")).err).toContain("--size must look like");
    expect((await clipmunk(cwd, "export", "--scene", "a", "--format", "gif", "--output", "a.gif")).err).toContain(
      "names its own",
    );
    expect(await clipmunk(cwd, "open", "--scene", "missing", "--no-launch")).toMatchObject({ code: 1 });
    // The Studio is the daemon's; with none running, open says how to start it.
    expect((await clipmunk(cwd, "open", "--url", "http://127.0.0.1:9", "--no-launch")).out).toContain(
      "npx clipmunk dev",
    );
    const token = "t".repeat(24);
    await writeFile(
      path.join(cwd, ".clipmunk/daemon.json"),
      JSON.stringify({ port: 4999, pid: 1, token, startedAt: new Date().toISOString() }),
    );
    const opened = await clipmunk(cwd, "open", "--url", "http://127.0.0.1:9", "--no-launch");
    expect(opened.out).toContain(`http://127.0.0.1:4999/?clipmunk=1#clipmunk-daemon=4999.${token}`);
    expect(opened.out).toContain("dev server is not answering");
    expect((await clipmunk(cwd, "sync")).out).toContain("Vite discovers scenes automatically");
  });

  it("lists, saves and applies presets", async () => {
    const id = "take-20261005-142233";
    const cwd = await host({
      [`.clipmunk/takes/${id}/take.json`]: JSON.stringify({
        version: 1,
        id,
        title: "Demo",
        createdAt: "2026-10-05T14:22:33.000Z",
        source: {
          width: 1280,
          height: 720,
          dpr: 2,
          durationMs: 5000,
          background: "#fff",
          screen: { file: "screen.webm", offsetMs: 0, latencyMs: 40, width: 2560, height: 1440 },
          events: { file: "events.jsonl", count: 0 },
        },
      }),
    });
    expect((await clipmunk(cwd, "preset", "list")).out).toContain("No presets yet.");
    expect(await clipmunk(cwd, "preset", "save", "plain", "--take", id)).toMatchObject({ code: 1 });
    expect((await clipmunk(cwd, "preset", "save", "plain", "--take", id, "--fields", "cursor,glow")).err).toContain(
      "--fields takes",
    );
    const saved = await clipmunk(cwd, "preset", "save", "plain", "--take", id, "--fields", "zoom,music");
    expect(saved).toMatchObject({
      code: 0,
      out: "Saved preset plain (no music · zoom up to 2.2x) in clipmunk.config.json.",
    });
    expect((await clipmunk(cwd, "preset", "list")).out).toContain("plain");
    expect(await clipmunk(cwd, "preset", "apply", "plain", "--take", id)).toMatchObject({ code: 0 });
    expect(JSON.parse(await readFile(path.join(cwd, `.clipmunk/takes/${id}/edit.json`), "utf8")).edit.zoom.mode).toBe(
      "auto",
    );
    expect((await clipmunk(cwd, "preset", "apply", "loud", "--take", id)).err).toContain('No preset named "loud"');
    expect((await clipmunk(cwd, "preset", "apply", "plain")).err).toContain("--take <id> or --scene <id>");
  });
});
