// Spike measurements: standalone Studio (iframe) vs today's in-app Studio, on the same machine.
import { writeFile, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HOST = "http://127.0.0.1:5180";
const SHELL = "http://127.0.0.1:4800";
// run.mjs passes the daemon it started; otherwise read the one started by hand.
const daemon = process.env.DAEMON
  ? JSON.parse(process.env.DAEMON)
  : JSON.parse((await readFile("/tmp/spike/daemon.log", "utf8")).trim().split("\n").pop()).data;
const DPR = Number(process.env.DPR ?? 1);
const PAIR = (process.env.PAIR ?? "700x490").split("x").map(Number);
const HASH = `#clipmunk-daemon=${daemon.port}.${daemon.token}`;
const SCENE = process.env.SCENE ?? "rack-focus";
const only = process.env.ONLY?.split(",");
const want = (name) => !only || only.includes(name);
const results = { scene: SCENE, machine: process.env.MACHINE ?? "server (2 cores, no GPU, headless)", dpr: DPR };
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, mean: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(2), p50: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2) };
};

const browser = await chromium.launch({ headless: !process.env.HEADED, channel: process.env.CHANNEL });
const context = await browser.newContext({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: DPR });
// Connect the daemon once for each origin, as the printed link would.
const page = await context.newPage();
page.on("pageerror", (e) => console.error("pageerror", e.message));
await page.goto(`${SHELL}/${HASH}`);
await page.waitForSelector("text=Scenes");

// --- In-app baseline: today's studio page, driven through the bridge in the page itself.
async function openInApp(viewport) {
  const p = await context.newPage();
  await p.setViewportSize(viewport);
  await p.goto(`${HOST}/?clipmunk=1&clipmunk-scene=${SCENE}`);
  await p.addStyleTag({ content: "[data-clipmunk-chrome]{display:none!important}" });
  await p.waitForFunction(() => typeof window.__CLIPMUNK__?.seek === "function", undefined, { timeout: 60_000 });
  await p.evaluate(() => window.__CLIPMUNK__.ready());
  return p;
}
async function openShell(query) {
  await page.goto(`${SHELL}/?scene=${SCENE}${query}`);
  await page.waitForFunction(() => window.spike.ready(), undefined, { timeout: 60_000 });
  if (query.includes("exact")) {
    await page.waitForFunction(() => window.spike.frames.every((f) => f.el.width === String(f.info.width)));
    await page.waitForTimeout(500);
  }
  return page.evaluate(() => window.spike.frames.map((f) => f.info));
}

// Random seek times, the same list for both, so the work is identical.
const times = (n, duration) => Array.from({ length: n }, (_, i) => Math.round(((i * 7919) % 1000) / 1000 * duration));

const native = async () => {
  const p = await openInApp({ width: 1600, height: 1000 });
  const size = await p.evaluate(() => ({ width: window.__CLIPMUNK__.width, height: window.__CLIPMUNK__.height }));
  await p.setViewportSize(size);
  await p.waitForTimeout(500);
  return p;
};
if (want("scrub")) {
  const inApp = await native();
  const duration = await inApp.evaluate(() => window.__CLIPMUNK__.durationMs);
  const list = times(80, duration);
  const appMs = await inApp.evaluate(async (list) => {
    const out = [];
    for (const t of list) { const s = performance.now(); await window.__CLIPMUNK__.seek(t); out.push(performance.now() - s); }
    return out;
  }, list);
  await inApp.close();
  await openShell("&exact=1");
  const shellMs = await page.evaluate(async (list) => {
    const out = [];
    for (const t of list) { const s = performance.now(); await window.spike.seek(t); out.push(performance.now() - s); }
    return out;
  }, list);
  // A fast drag: a seek every 4 ms. What matters is how soon the final position is on screen.
  const drag = await page.evaluate(async (duration) => {
    const sent = [];
    let last;
    for (let i = 0; i < 60; i++) { last = window.spike.seek((i / 59) * duration); sent.push(i); await new Promise((r) => setTimeout(r, 4)); }
    const s = performance.now();
    const answer = await last;
    return { finalFrameAfterDragMs: performance.now() - s, dropped: answer.dropped, seeks: sent.length };
  }, duration);
  results.scrub = { inApp: stats(appMs), standalone: stats(shellMs), overheadMeanMs: +(stats(shellMs).mean - stats(appMs).mean).toFixed(2), fastDrag: drag };
  console.log("scrub", results.scrub);
}

async function countAppFrames(p, seconds) {
  return p.evaluate(async (seconds) => {
    const b = window.__CLIPMUNK__;
    const start = performance.now();
    let frames = 0;
    while (performance.now() - start < seconds * 1000) {
      await b.seek(((performance.now() - start) % b.durationMs));
      frames++;
    }
    return frames / seconds;
  }, seconds);
}
if (want("play")) {
  const inApp = await native();
  const appFps = await countAppFrames(inApp, 4);
  await inApp.close();
  const playFor = async (count) => {
    await openShell(count === 2 ? "&frames=2&exact=1" : "&exact=1");
    const duration = await page.evaluate(() => window.spike.frames[0].info.durationMs);
    const seconds = Math.min(4, duration / 1000);
    await page.evaluate((count) => { for (let i = 0; i < count; i++) window.spike.play(i, 0); }, count);
    await page.waitForTimeout(seconds * 1000);
    await page.evaluate((count) => { for (let i = 0; i < count; i++) window.spike.pause(i); }, count);
    return page.evaluate(([count, seconds]) => Array.from({ length: count }, (_, i) => {
      const t = window.spike.ticks[i] ?? [];
      return +(t.filter((x) => x - t[0] <= seconds * 1000).length / seconds).toFixed(1);
    }), [count, seconds]);
  };
  results.playback = { inAppFps: +appFps.toFixed(1), standaloneFps: (await playFor(1))[0] };
  console.log("playback", results.playback);
}

// Two live frames side by side, both fully on screen, against one frame of the same size.
// Starving means the second frame gets far fewer frames than the first.
if (want("pair")) {
  const [w, h] = PAIR;
  const inApp = await openInApp({ width: w, height: h });
  await inApp.waitForTimeout(500);
  const appFps = await countAppFrames(inApp, 4);
  await inApp.close();
  const run = async (count) => {
    await page.goto(`${SHELL}/?scene=${SCENE}&frames=${count}&size=${w}x${h}`);
    await page.waitForFunction(() => window.spike.ready(), undefined, { timeout: 60_000 });
    await page.waitForTimeout(500);
    const visible = await page.evaluate(() => window.spike.frames.map((f) => {
      const r = f.el.getBoundingClientRect();
      return r.bottom <= innerHeight && r.right <= innerWidth;
    }));
    const duration = await page.evaluate(() => window.spike.frames[0].info.durationMs);
    const seconds = Math.min(4, duration / 1000);
    await page.evaluate((count) => { for (let i = 0; i < count; i++) window.spike.play(i, 0); }, count);
    await page.waitForTimeout(seconds * 1000);
    await page.evaluate((count) => { for (let i = 0; i < count; i++) window.spike.pause(i); }, count);
    const fps = await page.evaluate(([count, seconds]) => Array.from({ length: count }, (_, i) => {
      const t = window.spike.ticks[i] ?? [];
      return +(t.filter((x) => x - t[0] <= seconds * 1000).length / seconds).toFixed(1);
    }), [count, seconds]);
    return { fps, allOnScreen: visible.every(Boolean) };
  };
  results.pair = { size: `${w}x${h}`, inAppFps: +appFps.toFixed(1), oneFrame: await run(1), twoFrames: await run(2) };
  console.log("pair", results.pair);
}

if (want("pixels")) {
  const sample = [0, 0.33, 0.66, 1];
  const inApp = await openInApp({ width: 1600, height: 1000 });
  const info = await inApp.evaluate(() => ({ w: window.__CLIPMUNK__.width, h: window.__CLIPMUNK__.height, d: window.__CLIPMUNK__.durationMs }));
  // Same size for both pages so the scene is fitted at scale 1 in each.
  await inApp.setViewportSize({ width: info.w, height: info.h });
  const app = [];
  for (const f of sample) {
    await inApp.evaluate((t) => window.__CLIPMUNK__.seek(t), f * info.d);
    app.push(await inApp.locator("[data-clipmunk-capture]").screenshot());
  }
  await inApp.close();
  await openShell("&exact=1");
  await page.waitForFunction(([w]) => window.spike.frames[0].el.width === String(w), [info.w]);
  const frame = page.frameLocator("iframe").first();
  await page.waitForTimeout(500);
  const shell = [];
  for (const f of sample) {
    await page.evaluate((t) => window.spike.seek(t), f * info.d);
    shell.push(await frame.locator("[data-clipmunk-capture]").screenshot());
  }
  if (process.env.SAVE) { await writeFile("/tmp/spike/px-app.png", app[0]); await writeFile("/tmp/spike/px-shell.png", shell[0]); }
  const cmp = await context.newPage();
  const diffs = [];
  for (let i = 0; i < sample.length; i++) {
    diffs.push(await cmp.evaluate(async ([a, b]) => {
      const load = async (src) => { const img = new Image(); img.src = `data:image/png;base64,${src}`; await img.decode(); const c = new OffscreenCanvas(img.width, img.height); const x = c.getContext("2d"); x.drawImage(img, 0, 0); return x.getImageData(0, 0, img.width, img.height); };
      const [p, q] = [await load(a), await load(b)];
      if (p.width !== q.width || p.height !== q.height) return { sizeMismatch: [p.width, p.height, q.width, q.height] };
      let differing = 0, max = 0;
      for (let k = 0; k < p.data.length; k += 4) {
        const d = Math.max(Math.abs(p.data[k] - q.data[k]), Math.abs(p.data[k + 1] - q.data[k + 1]), Math.abs(p.data[k + 2] - q.data[k + 2]));
        if (d) differing++;
        max = Math.max(max, d);
      }
      return { size: `${p.width}x${p.height}`, differingPixels: differing, maxChannelDelta: max };
    }, [app[i].toString("base64"), shell[i].toString("base64")]));
  }
  await cmp.close();
  results.pixels = sample.map((f, i) => ({ atMs: Math.round(f * info.d), ...diffs[i] }));
  console.log("pixels", results.pixels);
}

if (want("picker")) {
  await openShell("");
  await page.evaluate(() => window.spike.pick(true));
  const box = await page.locator("iframe").first().boundingBox();
  const picked = page.waitForEvent("console", { predicate: () => false, timeout: 1 }).catch(() => {});
  await picked;
  const got = page.evaluate(() => new Promise((r) => window.addEventListener("spike", (e) => e.detail.type === "picked" && r(e.detail))));
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.45);
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.45);
  results.picker = await Promise.race([got, new Promise((r) => setTimeout(() => r({ error: "no pick in 3s" }), 3000))]);
  await page.evaluate(() => { window.spike.permissions(); });
  results.framePermissions = await page.evaluate(() => new Promise((r) => {
    const found = window.spike.events.find((e) => e.type === "permissions");
    if (found) return r(found);
    window.addEventListener("spike", (e) => e.detail.type === "permissions" && r(e.detail));
  }));
  console.log("picker", results.picker, results.framePermissions);
}

if (want("take")) {
  const list = await page.evaluate(async ([port, token]) => (await (await fetch(`http://127.0.0.1:${port}/v1/takes`, { headers: { authorization: `Bearer ${token}` } })).json()), [daemon.port, daemon.token]);
  const ok = list.data.takes.filter((t) => !t.issues?.length);
  const take = process.env.TAKE ?? (ok.at(-1) ?? list.data.takes.at(-1)).id;
  await page.goto(`${SHELL}/?take=${take}`);
  await page.waitForFunction(() => window.__CLIPMUNK__?.kind === "take", undefined, { timeout: 60_000 });
  const probe = await page.evaluate(async () => {
    const b = window.__CLIPMUNK__;
    await b.ready();
    const canvases = [...document.querySelectorAll("*")].flatMap((el) => [...(el.shadowRoot?.querySelectorAll("canvas") ?? []), ...(el.tagName === "CANVAS" ? [el] : [])]);
    const sample = async (t) => {
      await b.seek(t);
      const c = canvases[0];
      const copy = new OffscreenCanvas(64, 36); copy.getContext("2d").drawImage(c, 0, 0, 64, 36);
      const d = copy.getContext("2d").getImageData(0, 0, 64, 36).data;
      let sum = 0; const seen = new Set();
      for (let i = 0; i < d.length; i += 4) { sum += d[i] + d[i + 1] + d[i + 2]; seen.add((d[i] >> 4) * 256 + (d[i + 1] >> 4) * 16 + (d[i + 2] >> 4)); }
      return { t, colours: seen.size, mean: Math.round(sum / (d.length / 4) / 3) };
    };
    return { kind: b.kind, durationMs: b.durationMs, canvas: canvases.length, frames: [await sample(500), await sample(b.durationMs / 2)], encode: typeof b.encode };
  });
  await page.evaluate(() => window.__CLIPMUNK__.seek(window.__CLIPMUNK__.durationMs / 2));
  await page.screenshot({ path: "/tmp/spike/take-in-standalone.png" });
  results.take = { id: take, ...probe };
  console.log("take", results.take);
}

if (want("hmr")) {
  const dir = fileURLToPath(new URL("../../examples/vite-app/src/clipmunk/scenes", import.meta.url));
  const recipe = JSON.parse(await readFile(`${dir}/rack-focus.scene.json`, "utf8"));
  recipe.id = "spike-hmr";
  await writeFile(`${dir}/spike-hmr.scene.json`, JSON.stringify(recipe, null, 2));
  await writeFile(`${dir}/spike-hmr.tsx`, await readFile(`${dir}/rack-focus.tsx`, "utf8"));
  try {
    await page.waitForTimeout(1500);
    await page.goto(`${SHELL}/?scene=spike-hmr`);
    await page.waitForFunction(() => window.spike.ready(), undefined, { timeout: 60_000 });
    const before = await page.evaluate(() => window.spike.frames[0].info.durationMs);
    // Stretch the motion: an agent editing the recipe while the Studio is open.
    const motion = recipe.definition.motion;
    motion.speed = (motion.speed ?? 1) / 2;
    await writeFile(`${dir}/spike-hmr.scene.json`, JSON.stringify(recipe, null, 2));
    const after = await page.waitForFunction((before) => {
      const ready = window.spike.events.filter((e) => e.type === "ready");
      const last = ready.at(-1);
      return last && last.durationMs !== before ? last.durationMs : false;
    }, before, { timeout: 20_000 }).then((h) => h.jsonValue()).catch(() => "no update");
    const seekAfter = await page.evaluate(() => window.spike.seek(100).then((m) => m.type));
    results.hmr = { before, after, seekAfter, studioReloaded: false };
  } finally {
    await rm(`${dir}/spike-hmr.scene.json`, { force: true });
    await rm(`${dir}/spike-hmr.tsx`, { force: true });
  }
  console.log("hmr", results.hmr);
}

await browser.close();
const out = new URL(`./results-${process.env.LABEL ?? "server"}-${SCENE}.json`, import.meta.url);
const previous = JSON.parse(await readFile(out, "utf8").catch(() => "{}"));
await writeFile(out, JSON.stringify({ ...previous, ...results }, null, 2));
