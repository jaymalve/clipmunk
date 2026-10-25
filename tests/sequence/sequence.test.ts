import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Browser, chromium } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "../../src/cli/run";
import { type Daemon, startDaemon } from "../../src/daemon";
import { exportScene, exportSequence, probeMedia, probeVideo } from "../../src/export";
import { near as closeTo, colourAt, loudness as loudnessOf } from "../support/media";
import { FFMPEG, makeTake, QUADRANTS } from "../support/take";

/** Narration over a scene and sequences of scenes and takes, end to end on the example app. */
const root = path.resolve("examples/vite-app");
const TAKE = "zz-test-seq";
const recipePath = path.join(root, "src/clipmunk/scenes/rack-focus.scene.json");
const sequenceFile = (id: string) => path.join(root, "src/clipmunk/sequences", `${id}.sequence.json`);
const made: string[] = [];
let server: ViteDevServer,
  daemon: Daemon,
  origin: string,
  projectFile: string,
  recipeFile: string,
  hadSequences: boolean,
  hadAudio: boolean;

const call = async (method: string, route: string, body?: Buffer | object) => {
  const response = await fetch(`${daemon.origin}${route}`, {
    method,
    headers: { authorization: `Bearer ${daemon.token}`, origin },
    body: body === undefined ? undefined : Buffer.isBuffer(body) ? new Uint8Array(body) : JSON.stringify(body),
  });
  return {
    status: response.status,
    type: response.headers.get("content-type"),
    json: response.headers.get("content-type")?.includes("json") ? ((await response.json()) as any) : undefined,
  };
};
const tone = (seconds: number, format: string[]) =>
  execFileSync(
    FFMPEG,
    ["-loglevel", "error", "-f", "lavfi", "-i", `sine=frequency=330:duration=${seconds}`, ...format, "-"],
    { maxBuffer: 16e6 },
  );
const colour = (file: string, at: number, crop: string) => colourAt(path.join(root, file), at, crop);
const near = (actual: number[], expected: readonly number[]) => closeTo(actual, expected, 50);
const out = (name: string) => {
  made.push(name);
  return name;
};
const loudness = (file: string, from?: number, seconds?: number) => loudnessOf(path.join(root, file), from, seconds);

beforeAll(async () => {
  process.env.CLIPMUNK_FFMPEG ??= FFMPEG;
  projectFile = await readFile(path.join(root, ".clipmunk/project.json"), "utf8");
  recipeFile = await readFile(recipePath, "utf8");
  hadSequences = existsSync(path.join(root, "src/clipmunk/sequences"));
  hadAudio = existsSync(path.join(root, ".clipmunk/audio"));
  await makeTake(root, TAKE);
  server = await createServer({ root, server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
  await server.listen();
  origin = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`;
  // The Studio frames scenes from the dev server project.json names.
  await writeFile(
    path.join(root, ".clipmunk/project.json"),
    `${JSON.stringify({ ...JSON.parse(projectFile), devUrl: origin }, null, 2)}\n`,
  );
  daemon = await startDaemon({ root, port: 0, announce: false });
}, 120_000);
afterAll(async () => {
  await daemon?.close();
  await server?.close();
  await rm(path.join(root, ".clipmunk/takes", TAKE), { recursive: true, force: true });
  for (const file of made) await rm(path.join(root, file), { force: true });
  for (const id of ["zz-test-launch", "zz-built-here"]) await rm(sequenceFile(id), { force: true });
  if (!hadSequences) await rm(path.join(root, "src/clipmunk/sequences"), { recursive: true, force: true });
  if (!hadAudio) await rm(path.join(root, ".clipmunk/audio"), { recursive: true, force: true });
  await writeFile(recipePath, recipeFile);
  await writeFile(path.join(root, ".clipmunk/project.json"), projectFile);
});

describe("narration over a scene", () => {
  const audioOf = async () =>
    (JSON.parse(await readFile(recipePath, "utf8")).audio ?? []) as { file: string; offsetMs: number; gain: number }[];

  it("stores the recording as WAV, points the recipe at it, and exports the scene with sound", async () => {
    const stored = await call(
      "PUT",
      "/v1/scenes/rack-focus/narration?offset=-120",
      tone(1.5, ["-c:a", "libopus", "-f", "webm"]),
    );
    expect(stored.json).toMatchObject({ ok: true, data: { audio: [{ offsetMs: -120, gain: 1 }] } });
    const [clip] = await audioOf();
    expect(clip!.file).toMatch(/^rack-focus-narration-\d{14}\.wav$/);
    expect(existsSync(path.join(root, ".clipmunk/audio", clip!.file))).toBe(true);
    expect((await readdir(path.join(root, ".clipmunk/audio"))).filter((name) => name.endsWith(".upload"))).toEqual([]);
    const served = await call("GET", `/v1/audio/${clip!.file}`);
    expect([served.status, served.type]).toEqual([200, "audio/wav"]);
    // The rest of the recipe is untouched.
    expect(JSON.parse(await readFile(recipePath, "utf8")).definition).toEqual(JSON.parse(recipeFile).definition);

    const output = out(".clipmunk/exports/zz-test-narrated.mp4");
    const result = await exportScene(
      { sceneId: "rack-focus", url: origin, output, fps: 30, width: 500, height: 300, workers: 1 },
      { root },
    );
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.data).toMatchObject({ frames: 45, audio: true });
    expect(await probeMedia(output, root)).toMatchObject({ hasVideo: true, hasAudio: true, durationMs: 1500 });
  }, 240_000);

  it("replaces the previous narration, and removes it on request", async () => {
    const [first] = await audioOf();
    await new Promise((resolve) => setTimeout(resolve, 1100)); // file names carry a timestamp to the second
    await call("PUT", "/v1/scenes/rack-focus/narration?offset=0", tone(1, ["-c:a", "libopus", "-f", "webm"]));
    const after = await audioOf();
    expect(after).toHaveLength(1);
    expect(after[0]!.file).not.toBe(first!.file);
    expect(existsSync(path.join(root, ".clipmunk/audio", first!.file))).toBe(false);
    expect((await call("DELETE", "/v1/scenes/rack-focus/narration")).json).toMatchObject({
      ok: true,
      data: { audio: [] },
    });
    expect(await audioOf()).toEqual([]);
    expect(existsSync(path.join(root, ".clipmunk/audio", after[0]!.file))).toBe(false);
    expect("audio" in JSON.parse(await readFile(recipePath, "utf8"))).toBe(false);
    expect((await call("PUT", "/v1/scenes/nope/narration", tone(0.2, ["-c:a", "libopus", "-f", "webm"]))).status).toBe(
      404,
    );
    expect((await call("GET", "/v1/audio/..%2F..%2Fpackage.json")).status).toBe(404);
  }, 60_000);

  it("exports a scene without a sound file that has gone missing, and says so", async () => {
    const recipe = JSON.parse(recipeFile);
    await writeFile(recipePath, JSON.stringify({ ...recipe, audio: [{ file: "lost.wav" }] }, null, 2));
    const output = out(".clipmunk/exports/zz-test-missing-audio.mp4");
    const result = await exportScene(
      { sceneId: "rack-focus", url: origin, output, fps: 30, width: 500, height: 300, workers: 1 },
      { root },
    );
    await writeFile(recipePath, recipeFile);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.data.audio).toBe(false);
    expect(result.data.warnings).toEqual([
      ".clipmunk/audio/lost.wav is missing, so this scene was exported without it.",
    ]);
  }, 240_000);
});

describe("generated music", () => {
  const recipe = async () => JSON.parse(await readFile(recipePath, "utf8"));

  it("is set on a scene through the daemon and heard in its export", async () => {
    expect((await call("PUT", "/v1/scenes/rack-focus/music", { music: { style: "techno" } })).json).toMatchObject({
      ok: false,
      issues: [{ code: "invalid-music" }],
    });
    expect(
      (await call("PUT", "/v1/scenes/rack-focus/music", { music: { style: "upbeat", seed: 9 } })).json,
    ).toMatchObject({ ok: true, data: { music: { style: "upbeat", seed: 9, gain: 0.5, duck: true, sync: true } } });
    expect((await recipe()).music).toEqual({ style: "upbeat", seed: 9, gain: 0.5, duck: true, sync: true });
    expect((await recipe()).definition).toEqual(JSON.parse(recipeFile).definition);

    const output = out(".clipmunk/exports/zz-test-music-scene.mp4");
    const result = await exportScene(
      { sceneId: "rack-focus", url: origin, output, fps: 30, width: 500, height: 300, workers: 1 },
      { root },
    );
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.data.audio).toBe(true);
    expect(await probeMedia(output, root)).toMatchObject({ hasAudio: true, durationMs: 1500 });
    expect(loudness(output), "the music is audible").toBeGreaterThan(-35);

    // A caller can leave the music out, which is what a sequence with its own music does.
    const silent = out(".clipmunk/exports/zz-test-music-off.mp4");
    const without = await exportScene(
      {
        sceneId: "rack-focus",
        url: origin,
        output: silent,
        fps: 30,
        width: 500,
        height: 300,
        workers: 1,
        music: false,
      },
      { root },
    );
    expect(without.ok && without.data.audio).toBe(false);
  }, 240_000);

  it("plays over a whole sequence in place of its clips' own music", async () => {
    await call("PUT", "/v1/sequences/zz-test-music", {
      version: 1,
      id: "zz-test-music",
      title: "Music",
      width: 640,
      height: 360,
      fps: 30,
      music: { style: "lofi", gain: 0.6 },
      items: [
        { clip: { kind: "scene", id: "rack-focus" } },
        { clip: { kind: "scene", id: "rack-focus" }, transition: { kind: "fade", ms: 400 } },
      ],
    });
    const output = out(".clipmunk/exports/zz-test-music-sequence.mp4");
    const result = await exportSequence({ sequenceId: "zz-test-music", url: origin, output }, { root });
    await rm(sequenceFile("zz-test-music"), { force: true });
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.data).toMatchObject({ durationMs: 2600, audio: true });
    expect(loudness(output)).toBeGreaterThan(-35);

    expect((await call("PUT", "/v1/scenes/rack-focus/music", { music: null })).json).toMatchObject({
      ok: true,
      data: { music: null },
    });
    expect("music" in (await recipe())).toBe(false);
  }, 400_000);
});

describe("sound effects", () => {
  it("lay a scene's typing over a sequence where that scene plays, and nowhere else", async () => {
    const recipe = JSON.parse(await readFile(recipePath, "utf8"));
    // Typing from 0.3 s to 0.8 s of each 1.5 s copy of the scene.
    await writeFile(
      recipePath,
      JSON.stringify({ ...recipe, sounds: [{ kind: "typing", atMs: 300, chars: 5, perSecond: 10 }] }),
    );
    await call("PUT", "/v1/sequences/zz-test-sounds", {
      version: 1,
      id: "zz-test-sounds",
      title: "Sounds",
      width: 640,
      height: 360,
      fps: 30,
      items: [
        { clip: { kind: "scene", id: "rack-focus" } },
        { clip: { kind: "scene", id: "rack-focus" }, transition: { kind: "cut" } },
      ],
    });
    const output = out(".clipmunk/exports/zz-test-sounds-sequence.mp4");
    const result = await exportSequence({ sequenceId: "zz-test-sounds", url: origin, output }, { root });
    await rm(sequenceFile("zz-test-sounds"), { force: true });
    await writeFile(recipePath, recipeFile);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.data).toMatchObject({ durationMs: 3000, audio: true });
    for (const start of [0, 1.5]) {
      expect(loudness(output, start + 0.3, 0.5)).toBeGreaterThan(-60);
      expect(loudness(output, start + 0.95, 0.5)).toBeLessThan(-80);
    }
  }, 400_000);
});

describe("narrating in the studio", () => {
  let browser: Browser;
  afterAll(() => browser?.close());

  it("records the microphone while the scene plays, saves when it ends, and can remove it", async () => {
    // The full browser in headless mode: the lightweight headless shell has no audio capture.
    browser = await chromium.launch({ channel: "chromium", args: ["--use-fake-device-for-media-stream"] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ["microphone"] });
    const page = await context.newPage();
    page.on("pageerror", (error) => console.error("pageerror:", error.message));
    // The Studio's scene player: the scene and its narration run in a frame of the host.
    await page.goto(
      `${daemon.origin}/?clipmunk=1&clipmunk-scene=rack-focus#clipmunk-daemon=${daemon.port}.${daemon.token}`,
    );
    await page.frameLocator("iframe").locator('[data-clipmunk-scene][data-clipmunk-valid="true"]').waitFor();
    await page.getByRole("button", { name: "Narrate", exact: true }).waitFor({ timeout: 20_000 });
    const narrated = async () =>
      ((JSON.parse(await readFile(recipePath, "utf8")).audio ?? []) as { file: string }[]).length;
    expect(await narrated()).toBe(0);
    await page.getByRole("button", { name: "Narrate", exact: true }).click();
    await page
      .getByRole("button", { name: "Stop narrating" })
      .waitFor({ timeout: 10_000 })
      .catch(async () => {
        throw new Error(
          `Narration did not start. Page shows: ${JSON.stringify(await page.locator(".issues, .bar button").allTextContents())}`,
        );
      });
    // The scene is 1.5 s long; recording stops by itself when it ends.
    await expect.poll(narrated, { timeout: 20_000 }).toBe(1);
    const [clip] = JSON.parse(await readFile(recipePath, "utf8")).audio as { file: string; offsetMs: number }[];
    expect(clip!.file).toMatch(/^rack-focus-narration-/);
    expect(Math.abs(clip!.offsetMs)).toBeLessThan(500);
    const wav = await probeMedia(path.join(root, ".clipmunk/audio", clip!.file), root);
    expect(wav.hasAudio).toBe(true);
    expect(wav.durationMs).toBeGreaterThan(1000);
    await page.getByRole("button", { name: "Remove narration" }).click();
    await expect.poll(narrated, { timeout: 10_000 }).toBe(0);
    await page.getByRole("button", { name: "Narrate", exact: true }).waitFor({ timeout: 10_000 });

    // Music from the scene player: choosing a style writes it to the recipe, and Off removes it.
    const music = async () => JSON.parse(await readFile(recipePath, "utf8")).music;
    await page.getByRole("button", { name: "Music", exact: true }).click();
    await page
      .locator("label.field", { hasText: /^Music/ })
      .locator("select")
      .selectOption("lofi");
    await expect.poll(music, { timeout: 10_000 }).toEqual({ style: "lofi", gain: 0.5, duck: true, sync: true });
    await page.getByRole("button", { name: "Music ♪" }).waitFor({ timeout: 10_000 });
    await page.getByRole("button", { name: /^(Play|Replay)$/ }).click(); // plays with the music running
    await page.waitForTimeout(500);
    await page
      .locator("label.field", { hasText: /^Music/ })
      .locator("select")
      .selectOption("off");
    await expect.poll(music, { timeout: 10_000 }).toBeUndefined();
  }, 120_000);
});

describe("sequences", () => {
  const sequence = (transition: object, extra: object = {}) => ({
    version: 1,
    id: "zz-test-launch",
    title: "Launch",
    width: 640,
    height: 360,
    fps: 30,
    items: [{ clip: { kind: "scene", id: "rack-focus" } }, { clip: { kind: "take", id: TAKE }, transition }],
    ...extra,
  });

  it("saves through the daemon only when every clip exists", async () => {
    expect(
      (
        await call("PUT", "/v1/sequences/zz-test-launch", {
          ...sequence({ kind: "fade" }),
          items: [{ clip: { kind: "take", id: "no-such-take" } }],
        })
      ).json,
    ).toMatchObject({ ok: false, issues: [{ code: "unknown-clip" }] });
    expect(existsSync(sequenceFile("zz-test-launch"))).toBe(false);
    expect((await call("PUT", "/v1/sequences/zz-test-launch", sequence({ kind: "fade", ms: 500 }))).status).toBe(200);
    expect((await call("GET", "/v1/sequences")).json.data.sequences.map((entry: { id: string }) => entry.id)).toContain(
      "zz-test-launch",
    );
    expect((await call("GET", "/v1/sequences/missing")).status).toBe(404);
  });

  it("joins a scene and a take with a cross-fade into one file with sound", async () => {
    const output = out(".clipmunk/exports/zz-test-sequence.mp4");
    const result = await exportSequence({ sequenceId: "zz-test-launch", url: origin, output }, { root });
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    // 1.5 s scene + 4 s take, overlapped by the 0.5 s fade.
    expect(result.data).toMatchObject({
      output,
      items: 2,
      width: 640,
      height: 360,
      fps: 30,
      durationMs: 5000,
      audio: true,
    });
    expect(await probeVideo(output, root)).toMatchObject({ frames: 150, width: 640, height: 360, fps: 30 });
    const media = await probeMedia(output, root);
    expect(media.hasAudio).toBe(true);
    expect(Math.abs(media.durationMs - 5000)).toBeLessThanOrEqual(40);
    // The take starts at 1.0 s, so 3.0 s into the file is its zoomed moment (take time 2.0 s).
    expect(near(colour(output, 3.0, "20:20:170:95"), QUADRANTS.yellow)).toBe(true);
    expect(near(colour(output, 0.4, "20:20:170:95"), QUADRANTS.yellow)).toBe(false); // still the scene
    // Halfway through the fade the picture is a mix: no longer the scene alone, not yet the take alone.
    const scene = colour(output, 0.9, "20:20:170:95"),
      mixed = colour(output, 1.25, "20:20:170:95"),
      take = colour(output, 1.6, "20:20:170:95");
    const distance = (a: number[], b: number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
    expect(distance(mixed, scene)).toBeGreaterThan(25);
    expect(distance(mixed, take)).toBeGreaterThan(25);
    expect(
      existsSync(path.join(root, ".clipmunk/exports")) &&
        (await readdir(path.join(root, ".clipmunk/exports"))).filter((name) => name.startsWith(".clipmunk-")),
    ).toEqual([]);
    expect(await exportSequence({ sequenceId: "zz-test-launch", url: origin, output }, { root })).toMatchObject({
      ok: false,
      issues: [{ code: "output-exists" }],
    });
  }, 400_000);

  it("butts clips together on a cut, lays music over the whole, and explains a missing file", async () => {
    await mkdir(path.join(root, ".clipmunk/audio"), { recursive: true });
    await writeFile(path.join(root, ".clipmunk/audio/zz-test-music.wav"), tone(8, ["-f", "wav"]));
    made.push(".clipmunk/audio/zz-test-music.wav");
    await writeFile(
      sequenceFile("zz-test-launch"),
      JSON.stringify(sequence({ kind: "cut" }, { audio: [{ file: "zz-test-music.wav", gain: 0.3 }] })),
    );
    const output = out(".clipmunk/exports/zz-test-sequence-cut.mp4");
    const result = await exportSequence({ sequenceId: "zz-test-launch", url: origin, output }, { root });
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.data).toMatchObject({ durationMs: 5500, audio: true });
    const joined = await probeMedia(output, root);
    expect(joined.hasAudio).toBe(true);
    expect(Math.abs(joined.durationMs - 5500)).toBeLessThanOrEqual(40); // the last audio frame may run a few milliseconds over
    expect(near(colour(output, 3.5, "20:20:170:95"), QUADRANTS.yellow)).toBe(true); // take time 2.0 s again

    await writeFile(
      sequenceFile("zz-test-launch"),
      JSON.stringify(sequence({ kind: "cut" }, { audio: [{ file: "not-here.wav" }] })),
    );
    expect(await exportSequence({ sequenceId: "zz-test-launch", url: origin }, { root })).toMatchObject({
      ok: false,
      issues: [{ code: "missing-audio" }],
    });
    expect(await exportSequence({ sequenceId: "nope", url: origin }, { root })).toMatchObject({
      ok: false,
      issues: [{ code: "unknown-sequence" }],
    });
    await writeFile(sequenceFile("zz-test-launch"), JSON.stringify(sequence({ kind: "fade", ms: 500 })));
  }, 400_000);

  it("is listed by the CLI", async () => {
    const lines: string[] = [];
    const code = await run(["sequences"], {
      cwd: root,
      out: (text) => lines.push(text),
      err: (text) => lines.push(text),
      version: "test",
    });
    expect(code).toBe(0);
    expect(lines.join("\n")).toMatch(/zz-test-launch\s+2 clips\s+640x360@30\s+Launch/);
  });
});

describe("sequence builder in the studio", () => {
  let browser: Browser;
  afterAll(() => browser?.close());

  it("creates a sequence, adds a clip with a fade, and saves it as a file", async () => {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on("pageerror", (error) => console.error("pageerror:", error.message));
    await page.goto(`${daemon.origin}/?clipmunk=1#clipmunk-daemon=${daemon.port}.${daemon.token}`);
    await page.getByLabel("New sequence name").fill("ZZ built here");
    await page.getByRole("button", { name: "Create" }).click();
    await page.waitForURL(/clipmunk-sequence=zz-built-here/);
    await page.getByLabel("Add a clip").selectOption(`take:${TAKE}`);
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await page.getByLabel("Fade length into clip 2, milliseconds").fill("800");
    await page.getByLabel("Shape").selectOption("1:1");
    await expect
      .poll(
        async () =>
          existsSync(sequenceFile("zz-built-here"))
            ? JSON.parse(await readFile(sequenceFile("zz-built-here"), "utf8"))
            : undefined,
        { timeout: 10_000 },
      )
      .toMatchObject({
        id: "zz-built-here",
        title: "ZZ built here",
        width: 1080,
        height: 1080,
        items: [
          { clip: { kind: "scene" } },
          { clip: { kind: "take", id: TAKE }, transition: { kind: "fade", ms: 800 } },
        ],
      });
    await page.getByRole("button", { name: "Move up" }).nth(1).click();
    await expect
      .poll(async () => JSON.parse(await readFile(sequenceFile("zz-built-here"), "utf8")).items[0].clip.kind)
      .toBe("take");
    await page.goto(`${daemon.origin}/?clipmunk=1`);
    await page.locator(".row", { hasText: "ZZ built here" }).waitFor({ timeout: 15_000 });
  }, 120_000);
});
