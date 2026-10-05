// Spike 4: how fast can frames leave the page? DOM clips must be screenshotted; canvas clips can encode in-page.
import { chromium } from "playwright";
const W = 1920, H = 1080, N = 40;
const html = `<body style="margin:0;background:#000;overflow:hidden"><div id=stage style="width:${W}px;height:${H}px;perspective:1400px">
<div id=s style="width:1400px;height:900px;margin:90px auto;background:#fff;font:16px sans-serif;display:grid;grid-template-columns:repeat(8,1fr);gap:8px;padding:16px;box-sizing:border-box;filter:blur(1.5px)">
${Array.from({ length: 160 }, (_, i) => `<div style="background:hsl(${i * 7},60%,90%);border-radius:8px;padding:8px">Row ${i}<br><b>${(i * 7919) % 1000}</b></div>`).join("")}</div></div>
<canvas id=c width=${W} height=${H} style="display:none"></canvas>
<script>
window.seek = i => { document.getElementById('s').style.transform = 'rotateY(' + (-24 + i * 0.3) + 'deg) rotateX(10deg) translateZ(' + i * 2 + 'px)'; };
window.encodeCanvas = async (n, codec) => {
  const c = document.getElementById('c'), g = c.getContext('2d'); let bytes = 0, chunks = 0;
  const enc = new VideoEncoder({ output: ch => { bytes += ch.byteLength; chunks++; }, error: e => { throw e; } });
  const cfg = { codec, width: c.width, height: c.height, bitrate: 12e6, framerate: 60 };
  if (!(await VideoEncoder.isConfigSupported(cfg)).supported) return { supported: false };
  enc.configure(cfg); const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    g.fillStyle = '#123'; g.fillRect(0, 0, c.width, c.height);
    for (let k = 0; k < 200; k++) { g.fillStyle = 'hsl(' + (k * 9 + i * 3) + ',70%,60%)'; g.fillRect((k * 97 + i * 5) % c.width, (k * 53) % c.height, 120, 80); }
    const f = new VideoFrame(c, { timestamp: i * 1e6 / 60 }); enc.encode(f, { keyFrame: i % 60 === 0 }); f.close();
    while (enc.encodeQueueSize > 4) await new Promise(r => setTimeout(r, 1));
  }
  await enc.flush(); return { supported: true, msPerFrame: +((performance.now() - t0) / n).toFixed(1), chunks, kb: Math.round(bytes / 1024) };
};
</script>`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
await page.route("http://localhost/spike", r => r.fulfill({ contentType: "text/html", body: html }));
await page.goto("http://localhost/spike");
const cdp = await page.context().newCDPSession(page);
const clip = { x: 0, y: 0, width: W, height: H };
const time = async fn => { const t0 = performance.now(); let bytes = 0; for (let i = 0; i < N; i++) { await page.evaluate(i => window.seek(i), i); bytes += await fn(); } return { msPerFrame: +((performance.now() - t0) / N).toFixed(1), kbPerFrame: Math.round(bytes / N / 1024) }; };
const out = {};
if (process.argv[2] !== "enc") {
out["playwright screenshot png (Flute's method)"] = await time(async () => (await page.screenshot({ clip, type: "png", animations: "disabled" })).length);
out["playwright screenshot jpeg q92"] = await time(async () => (await page.screenshot({ clip, type: "jpeg", quality: 92 })).length);
out["CDP captureScreenshot png optimizeForSpeed"] = await time(async () => (await cdp.send("Page.captureScreenshot", { format: "png", optimizeForSpeed: true, clip: { ...clip, scale: 1 } })).data.length * 0.75);
out["CDP captureScreenshot jpeg q92"] = await time(async () => (await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 92, clip: { ...clip, scale: 1 } })).data.length * 0.75);
}
for (const codec of ["vp09.00.40.08", "avc1.640028", "av01.0.08M.08"]) out["in-page canvas -> VideoEncoder " + codec] = await page.evaluate(([n, c]) => window.encodeCanvas(n, c), [N, codec]).catch(e => ({ error: String(e.message).slice(0, 100) }));
console.log(JSON.stringify(out, null, 1));
await browser.close();
