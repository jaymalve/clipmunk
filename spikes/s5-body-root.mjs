// Spike 5: can <body> be the capture root, with the HUD mounted on <html> outside it? (Keeps portalled modals in the recording.)
import { chromium } from "playwright";
const html = `<!doctype html><style>html,body{margin:0;height:100%}body{background:rgb(0,0,255)}</style>
<div id=root style="height:100%"></div>
<script>
window.run = async (mode) => {
  const hud = document.createElement('flick-hud');
  hud.style.cssText = 'position:fixed;right:0;top:0;width:300px;height:300px;background:rgb(255,0,0);z-index:2147483647';
  document.documentElement.append(hud);
  // A modal portalled to body, as UI libraries do.
  const modal = document.createElement('div'); modal.style.cssText = 'position:fixed;left:100px;top:100px;width:200px;height:200px;background:rgb(0,255,0);z-index:999';
  document.body.append(modal);
  if (mode.isolate) document.body.style.isolation = 'isolate';
  const s = await navigator.mediaDevices.getDisplayMedia({ video: true, preferCurrentTab: true });
  const t = s.getVideoTracks()[0];
  await t.restrictTo(await RestrictionTarget.fromElement(document.body));
  const v = document.createElement('video'); v.srcObject = s; v.muted = true; await v.play();
  for (let i = 0; i < 5; i++) { modal.style.opacity = 1 - i * 0.001; await Promise.race([new Promise(r => v.requestVideoFrameCallback(r)), new Promise(r => setTimeout(r, 400))]); }
  const c = new OffscreenCanvas(v.videoWidth, v.videoHeight), g = c.getContext('2d'); g.drawImage(v, 0, 0);
  const k = v.videoWidth / innerWidth, px = (x, y) => Array.from(g.getImageData(Math.round(x * k), Math.round(y * k), 1, 1).data.slice(0, 3));
  return { frame: v.videoWidth + 'x' + v.videoHeight, viewport: innerWidth + 'x' + innerHeight, hudArea: px(innerWidth - 150, 150), modalArea: px(200, 200), plain: px(600, 500) };
};
</script>`;
for (const mode of [{ isolate: false }, { isolate: true }]) {
  const b = await chromium.launch({ headless: false, args: ["--auto-accept-this-tab-capture"] });
  const p = await b.newPage({ viewport: null });
  await p.route("http://localhost/s", r => r.fulfill({ contentType: "text/html", body: html })); await p.goto("http://localhost/s");
  const r = await Promise.race([p.evaluate(m => window.run(m).catch(e => e.name + ": " + e.message), mode), new Promise(r => setTimeout(() => r("timeout"), 15000))]);
  console.log(JSON.stringify(mode), JSON.stringify(r)); await b.close();
}
