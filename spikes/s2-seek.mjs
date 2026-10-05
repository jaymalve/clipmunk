// Spike 2: frame-accurate random access to video inside headless Chromium (the export environment).
// Test clips encode their frame number as 8 vertical black/white bars, so every decoded frame identifies itself.
import { chromium } from "playwright";
import http from "node:http";
import { createReadStream, statSync } from "node:fs";

const html = `<!doctype html><script type=module>
import * as MB from '/node_modules/mediabunny/dist/bundles/mediabunny.mjs';
const FPS = 60;
const readIndex = (source, w, h) => {
  const c = new OffscreenCanvas(w, h), g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(source, 0, 0, w, h);
  let n = 0;
  for (let b = 0; b < 8; b++) if (g.getImageData(Math.round((b + 0.5) * w / 8), h >> 1, 1, 1).data[0] > 127) n |= 1 << b;
  return n;
};
// Visit frames in a shuffled order so forward-only decoding cannot hide seek errors.
const order = n => Array.from({ length: n }, (_, i) => (i * 37) % n);

window.viaVideoElement = async (file, frames) => {
  const v = document.createElement('video'); v.muted = true; v.preload = 'auto'; v.src = file;
  await new Promise((r, j) => { v.onloadeddata = r; v.onerror = () => j(new Error('video error ' + v.error?.message)); });
  const info = { duration: v.duration, w: v.videoWidth };
  let wrong = 0, worst = 0; const t0 = performance.now();
  for (const i of order(frames)) {
    v.currentTime = (i + 0.5) / FPS;
    await new Promise(r => v.addEventListener('seeked', r, { once: true }));
    const got = readIndex(v, 640, 360);
    if (got !== i) { wrong++; worst = Math.max(worst, Math.abs(got - i)); }
  }
  return { ...info, wrong, worstOffBy: worst, msPerFrame: +((performance.now() - t0) / frames).toFixed(1) };
};
window.viaWebCodecs = async (file, frames) => {
  const input = new MB.Input({ source: new MB.UrlSource(new URL(file, location.href).href), formats: MB.ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  const info = { codec: track.codec, canDecode: await track.canDecode(), duration: +(await input.computeDuration()).toFixed(3) };
  if (!info.canDecode) return info;
  const sink = new MB.VideoSampleSink(track);
  let wrong = 0, worst = 0; let t0 = performance.now();
  for (const i of order(frames)) {
    const s = await sink.getSample((i + 0.5) / FPS);
    const f = s.toVideoFrame(); const got = readIndex(f, 640, 360); f.close(); s.close();
    if (got !== i) { wrong++; worst = Math.max(worst, Math.abs(got - i)); }
  }
  const random = +((performance.now() - t0) / frames).toFixed(1);
  // Export reads frames in order, so also time a sequential pass.
  t0 = performance.now(); let seq = 0, seqWrong = 0;
  for await (const s of sink.samples(0, frames / FPS)) { const f = s.toVideoFrame(); if (readIndex(f, 640, 360) !== seq) seqWrong++; f.close(); s.close(); seq++; }
  return { ...info, wrong, worstOffBy: worst, msPerFrameRandom: random, sequentialFrames: seq, sequentialWrong: seqWrong, msPerFrameSequential: +((performance.now() - t0) / seq).toFixed(1) };
};
window.probe = async file => {
  const v = document.createElement('video'); v.muted = true; v.src = file;
  await new Promise((r, j) => { v.onloadedmetadata = r; v.onerror = () => j(new Error('video error')); });
  const out = { elementDuration: String(v.duration) };
  try {
    const input = new MB.Input({ source: new MB.UrlSource(new URL(file, location.href).href), formats: MB.ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    const stats = await track.computePacketStats();
    out.packets = stats.packetCount; out.avgFps = +stats.averagePacketRate.toFixed(2);
    out.duration = +(await input.computeDuration()).toFixed(3);
  } catch (e) { out.mbError = String(e.message).slice(0, 120); }
  return out;
};
window.ready = true;
</script>`;

const server = http.createServer((req, res) => {
  if (req.url === "/") return res.setHeader("content-type", "text/html").end(html);
  const file = "." + decodeURIComponent(req.url.split("?")[0]);
  let size; try { size = statSync(file).size; } catch { return res.writeHead(404).end(); }
  const type = file.endsWith(".mjs") ? "text/javascript" : file.endsWith(".mp4") ? "video/mp4" : "video/webm";
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
  if (!m) { res.writeHead(200, { "content-type": type, "content-length": size, "accept-ranges": "bytes" }); return createReadStream(file).pipe(res); }
  const start = +m[1], end = m[2] ? Math.min(+m[2], size - 1) : size - 1;
  res.writeHead(206, { "content-type": type, "content-length": end - start + 1, "content-range": `bytes ${start}-${end}/${size}`, "accept-ranges": "bytes" });
  createReadStream(file, { start, end }).pipe(res);
}).listen(0);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.setDefaultTimeout(120_000);
await page.goto(`http://localhost:${server.address().port}/`);
await page.waitForFunction(() => window.ready);
const call = (fn, ...args) => page.evaluate(([f, a]) => window[f](...a), [fn, args]).catch(e => ({ error: String(e.message).split("\n")[0].slice(0, 160) }));
const out = {};
for (const file of ["/t-vp9-g30.webm", "/t-vp9-g1.webm", "/t-h264-g30.mp4"]) {
  out[file] = { videoElement: await call("viaVideoElement", file, 120), webCodecs: await call("viaWebCodecs", file, 120) };
}
for (const file of ["/out-rec-vp9.webm", "/t-rec-remux.webm", "/t-rec-cfr.webm"]) out[file] = await call("probe", file);
console.log(JSON.stringify(out, null, 1));
await browser.close(); server.close();
