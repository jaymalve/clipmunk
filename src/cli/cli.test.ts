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
  const root = await mkdtemp(path.join(os.tmpdir(), "flick-cli-"));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
  return root;
}
async function flick(cwd: string, ...args: string[]) {
  const out: string[] = [],
    err: string[] = [];
  const code = await run(args, { cwd, out: (text) => out.push(text), err: (text) => err.push(text), version: "9.9.9" });
  return { code, out: out.join("\n"), err: err.join("\n") };
}
const VITE = {
  "package.json": JSON.stringify({ dependencies: { react: "19", "react-dom": "19", vite: "8" } }),
  "src/main.jsx": 'createRoot(document.getElementById("root")).render(<App />);\n',
};

describe("flick cli", () => {
  it("prints help, the version, and rejects unknown commands and flags", async () => {
    const cwd = await host();
    expect((await flick(cwd, "--help")).out).toContain("flick <command>");
    expect(await flick(cwd, "--version")).toMatchObject({ code: 0, out: "9.9.9" });
    expect((await flick(cwd)).code).toBe(1);
    expect(await flick(cwd, "frobnicate")).toMatchObject({ code: 1 });
    expect((await flick(cwd, "scenes", "--nope")).err).toContain("flick <command>");
  });

  it("prints the guide as prose and as JSON", async () => {
    const cwd = await host();
    expect((await flick(cwd, "guide")).out).toContain("# Flick authoring guide");
    expect(JSON.parse((await flick(cwd, "guide", "--json")).out)).toEqual(JSON.parse(JSON.stringify(getGuide())));
  });

  it("initialises a project and reports the same result in both formats", async () => {
    const cwd = await host(VITE);
    const human = await flick(cwd, "init");
    expect(human.code).toBe(0);
    expect(human.out).toContain("Connected Flick (vite).");
    expect(human.out).toContain("wrapped  src/main.jsx");
    const json = JSON.parse((await flick(cwd, "init", "--json")).out);
    expect(json.ok && json.data.entry.status).toBe("already");
    expect(await flick(cwd, "init", "--adapter", "angular")).toMatchObject({ code: 1 });
  });

  it("explains failures on stderr with a non-zero exit, and as a result object with --json", async () => {
    const cwd = await host();
    const human = await flick(cwd, "init");
    expect(human).toMatchObject({ code: 1, out: "" });
    expect(human.err).toContain("No package.json here");
    const json = await flick(cwd, "init", "--json");
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
    expect(await flick(cwd, "scenes")).toMatchObject({ code: 0 });
    expect((await flick(cwd, "scenes")).out).toContain("page-survey");
    await writeFile(
      path.join(cwd, "src/flick/scenes/half.scene.json"),
      JSON.stringify({ ...guide.example.recipe, id: "half" }),
    );
    const broken = await flick(cwd, "scenes");
    expect(broken.code).toBe(1);
    expect(broken.out).toContain("needs a component next to it");
  });

  it("runs the daemon until interrupted and lists takes", async () => {
    const cwd = await host(VITE);
    expect((await flick(cwd, "dev", "--port", "70000")).err).toContain("--port must be a port number");
    expect((await flick(cwd, "takes")).out).toContain("No takes yet");
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
    expect(data.link).toBe(`http://127.0.0.1:5173/?flick=1#flick-daemon=${data.port}.${data.token}`);
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
    expect((await flick(cwd, "music")).err).toContain("music needs a style");
    expect((await flick(cwd, "music", "jazz")).code).toBe(1);
    const made = await flick(cwd, "music", "lofi", "--seed", "5", "--seconds", "2");
    expect(made.out).toContain("Wrote flick-lofi-5.wav: lofi, seed 5, 2 s at 82 beats per minute");
    const wav = await readFile(path.join(cwd, "flick-lofi-5.wav"));
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav.length).toBe(44 + 2 * 44100 * 4);
    expect((await flick(cwd, "music", "lofi", "--seed", "5", "--seconds", "2")).err).toContain("already exists");
    expect((await flick(cwd, "music", "lofi", "--output", "../outside.wav")).code).toBe(1);
  });

  it("asks for what is missing before rendering", async () => {
    const cwd = await host(VITE);
    expect((await flick(cwd, "export")).err).toContain("export needs --scene");
    expect((await flick(cwd, "snapshot", "--scene", "a")).err).toContain("npx flick init");
    await flick(cwd, "init");
    expect((await flick(cwd, "export", "--scene", "a", "--size", "big")).err).toContain("--size must look like");
    expect(await flick(cwd, "open", "--scene", "missing", "--no-launch")).toMatchObject({ code: 1 });
    const opened = await flick(cwd, "open", "--url", "http://127.0.0.1:9", "--no-launch");
    expect(opened.out).toContain("http://127.0.0.1:9/?flick=1");
    expect(opened.out).toContain("Nothing is answering there yet");
    expect((await flick(cwd, "sync")).out).toContain("Vite discovers scenes automatically");
  });
});
