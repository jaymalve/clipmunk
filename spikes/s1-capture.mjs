// Spike 1: can a tab record its own app root without the HUD or the native cursor?
// Run: xvfb-run -a -s "-screen 0 1600x1000x24" node s1-capture.mjs
import { chromium } from "playwright";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const html = `<!doctype html><meta charset=utf8>
<style>
  html,body{margin:0;height:100%;background:#fff}
  #app{position:absolute;inset:0;isolation:isolate;background:rgb(0,0,255)}
  #app.nocursor, #app.nocursor *{cursor:none!important}
  #hud{position:fixed;right:0;top:0;width:300px;height:300px;background:rgb(255,0,0);z-index:9999}
</style>
<div id=app></div><div id=hud></div>
<script>
const out = {};
window.run = async (mode) => {
  const app = document.getElementById('app');
  out.apis = {
    RestrictionTarget: typeof RestrictionTarget, CropTarget: typeof CropTarget,
    MediaStreamTrackProcessor: typeof MediaStreamTrackProcessor, VideoEncoder: typeof VideoEncoder,
  };
  out.mime = Object.fromEntries(['video/mp4;codecs=avc1.640028','video/mp4;codecs=vp9','video/mp4;codecs=av01.0.08M.08',
    'video/webm;codecs=vp9','video/webm;codecs=vp8','video/webm;codecs=av1','video/webm;codecs=h264']
    .map(m => [m, MediaRecorder.isTypeSupported(m)]));
  out.supportedConstraints = { cursor: !!navigator.mediaDevices.getSupportedConstraints().cursor };
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: 60, cursor: mode.cursor }, audio: false, preferCurrentTab: true, selfBrowserSurface: 'include' });
  const track = stream.getVideoTracks()[0];
  if (mode.restrict) await track.restrictTo(await RestrictionTarget.fromElement(app));
  if (mode.crop) await track.cropTo(await CropTarget.fromElement(app));
  out.settings = track.getSettings();
  out.capCursor = track.getCapabilities().cursor;
  window.stream = stream;
  const video = document.createElement('video'); video.srcObject = stream; video.muted = true; await video.play();
  window.video = video;
  return out;
};
// Sample the live stream: mean RGB of a small box centred at CSS px (x,y).
window.sample = async (x, y) => {
  const v = window.video;
  // Tab capture only emits frames on damage: repaint one corner pixel, then wait briefly.
  for (let i = 0; i < 3; i++) {
    let t = document.getElementById('tick') || document.getElementById('app').appendChild(Object.assign(document.createElement('i'), { id: 'tick' }));
    t.style.cssText = 'position:absolute;left:0;top:0;width:2px;height:2px;background:rgb(0,0,' + (250 + i) + ')';
    await Promise.race([new Promise(r => v.requestVideoFrameCallback(r)), new Promise(r => setTimeout(r, 400))]);
  }
  const c = new OffscreenCanvas(v.videoWidth, v.videoHeight), g = c.getContext('2d');
  g.drawImage(v, 0, 0);
  const sx = v.videoWidth / innerWidth, sy = v.videoHeight / innerHeight;
  const d = g.getImageData(Math.round(x*sx)-6, Math.round(y*sy)-6, 24, 24).data;
  let nonBg = 0;
  for (let i = 0; i < d.length; i += 4) if (!(d[i] < 40 && d[i+1] < 40 && d[i+2] > 200)) nonBg++;
  return { w: v.videoWidth, h: v.videoHeight, centre: [d[0], d[1], d[2]], nonBlueOf576: nonBg };
};
window.record = async (ms, mimeType) => {
  const rec = new MediaRecorder(window.stream, { mimeType, videoBitsPerSecond: 8e6 });
  const chunks = []; rec.ondataavailable = e => chunks.push(e.data);
  rec.start(250);
  // Animate so the recorder receives frames: a white bar sweeping across the app.
  const bar = document.getElementById('app').appendChild(document.createElement('i'));
  const t0 = performance.now();
  await new Promise(r => { const f = () => { const t = performance.now() - t0;
    bar.style.cssText = 'position:absolute;top:500px;height:40px;width:40px;background:#fff;left:' + (t / ms * 800) + 'px';
    t < ms ? requestAnimationFrame(f) : r(); }; f(); });
  await new Promise(r => { rec.onstop = r; rec.stop(); });
  const buf = new Uint8Array(await new Blob(chunks).arrayBuffer());
  let s = ''; for (let i = 0; i < buf.length; i += 32768) s += String.fromCharCode(...buf.subarray(i, i + 32768));
  return btoa(s);
};
</script>`;

const server = http.createServer((_, res) => res.end(html)).listen(0);
const url = `http://localhost:${server.address().port}/`;
const warp = (x, y) => execFileSync("python3", ["-c", `
import ctypes,sys
x=ctypes.CDLL('libX11.so.6'); d=x.XOpenDisplay(None); r=x.XDefaultRootWindow(d)
x.XWarpPointer(d,0,r,0,0,0,0,int(sys.argv[1]),int(sys.argv[2])); x.XFlush(d); x.XCloseDisplay(d)`, String(x), String(y)]);

const results = {};
for (const [name, mode] of Object.entries({
  plain: {},
  restrict: { restrict: true },
  crop: { crop: true },
  "restrict+cursor:never": { restrict: true, cursor: "never" },
  "restrict+css-none": { restrict: true, cssNone: true },
})) {
  const browser = await chromium.launch({ headless: false, args: ["--auto-accept-this-tab-capture", "--window-position=0,0", "--window-size=1400,900"] });
  const page = await browser.newPage({ viewport: null });
  try {
    page.setDefaultTimeout(15000); const step = s => console.error(name, s);
    await page.goto(url); step("loaded");
    const info = await Promise.race([page.evaluate(m => window.run(m), mode), new Promise((_, r) => setTimeout(() => r(new Error("run() timed out")), 12000))]); step("capturing");
    if (mode.cssNone) await page.evaluate(() => document.getElementById("app").classList.add("nocursor"));
    const geo = await page.evaluate(() => ({ sx: screenX, sy: screenY, top: outerHeight - innerHeight, iw: innerWidth, ih: innerHeight }));
    // Park the real X pointer over a plain blue part of the app, then look for non-blue pixels there.
    const px = 400, py = 400;
    warp(geo.sx + px, geo.sy + geo.top + py);
    step("warped"); await page.waitForTimeout(600);
    const atPointer = await page.evaluate(([x, y]) => window.sample(x + 6, y + 8), [px, py]);
    step("sampled pointer"); const atHud = await page.evaluate(([x, y]) => window.sample(x, y), [geo.iw - 150, 150]);
    results[name] = { settings: info.settings, capCursor: info.capCursor, hudCaptured: atHud.centre[0] > 200, hudPixel: atHud.centre,
      cursorPixelsAtPointer: atPointer.nonBlueOf576, frame: `${atPointer.w}x${atPointer.h}` };
    if (name === "plain") { results.apis = info.apis; results.mime = info.mime; results.supportedConstraints = info.supportedConstraints; }
    if (name === "restrict") {
      for (const m of ["video/webm;codecs=vp9", "video/webm;codecs=vp8"]) {
        if (!info.mime?.[m] && !results.mime?.[m]) continue;
        const b64 = await page.evaluate(([ms, mt]) => window.record(ms, mt), [4000, m]);
        const file = `out-rec-${m.split("=")[1]}.webm`;
        writeFileSync(file, Buffer.from(b64, "base64"));
        results["recorded:" + m] = file;
      }
    }
  } catch (e) { results[name] = { error: String(e.message).slice(0, 300) }; }
  await browser.close();
}
server.close();
console.log(JSON.stringify(results, null, 1));
