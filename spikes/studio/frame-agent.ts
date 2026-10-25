// Spike: runs inside the host app's page when it is framed by the standalone Studio.
// Talks to the existing capture bridge (window.__CLIPMUNK__), the same one export uses.
type Bridge = { durationMs: number; width: number; height: number; seek(t: number): Promise<void>; ready(): Promise<void> };
const STUDIO = "http://127.0.0.1:4800";
const framed = window.parent !== window && new URLSearchParams(location.search).has("clipmunk-frame");

if (framed) {
  const style = document.createElement("style");
  // Same rule the exporter applies: the in-app player chrome is not part of the picture.
  style.textContent = "[data-clipmunk-chrome],vite-error-overlay{display:none!important}";
  document.head.append(style);

  const bridge = () => (window as unknown as { __CLIPMUNK__?: Bridge }).__CLIPMUNK__;
  const post = (message: object) => window.parent.postMessage({ cm: 1, ...message }, STUDIO);

  // Announce (and re-announce after hot reloads replace the bridge).
  let announced: Bridge | undefined;
  setInterval(async () => {
    const b = bridge();
    if (!b || b === announced) return;
    announced = b;
    await b.ready();
    post({ type: "ready", durationMs: b.durationMs, width: b.width, height: b.height });
  }, 50);

  // Scrubbing: latest position wins. At most one seek in flight; stale ones are dropped.
  let busy = false;
  let pending: { t: number; seq: number } | undefined;
  let dropped = 0;
  async function drain() {
    if (busy || !pending) return;
    busy = true;
    while (pending) {
      const { t, seq } = pending;
      pending = undefined;
      const started = performance.now();
      try {
        await bridge()!.seek(t);
        post({ type: "frame", t, seq, renderMs: performance.now() - started, dropped });
      } catch (error) {
        post({ type: "error", seq, message: String(error) });
      }
    }
    busy = false;
  }

  // Playback: the frame runs its own loop; the Studio only hears the time.
  let playing = false;
  async function play(from: number, rate: number) {
    playing = true;
    const b = bridge()!;
    const start = performance.now() - from / rate;
    let frames = 0;
    const t0 = performance.now();
    while (playing) {
      const t = Math.min(b.durationMs, (performance.now() - start) * rate);
      await b.seek(t);
      frames++;
      post({ type: "tick", t });
      if (t >= b.durationMs) break;
    }
    playing = false;
    post({ type: "stopped", frames, ms: performance.now() - t0 });
  }

  // Element picker: hover outline, click reports a selector and a rect in scene pixels.
  let picking = false;
  const outline = document.createElement("div");
  outline.style.cssText = "position:fixed;pointer-events:none;border:2px dashed #f5a623;z-index:2147483647;display:none";
  document.documentElement.append(outline);
  const selectorFor = (el: Element): string => {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const parts: string[] = [];
    for (let node: Element | null = el; node && node.tagName !== "BODY"; node = node.parentElement) {
      if (node.matches("[data-clipmunk-capture]")) break;
      const cls = [...node.classList].slice(0, 2).map((c) => `.${CSS.escape(c)}`).join("");
      const index = node.parentElement ? [...node.parentElement.children].filter((c) => c.tagName === node!.tagName).indexOf(node) : 0;
      parts.unshift(`${node.tagName.toLowerCase()}${cls}${cls ? "" : `:nth-of-type(${index + 1})`}`);
      if (cls) break;
    }
    return parts.join(" > ");
  };
  document.addEventListener("pointermove", (event) => {
    if (!picking) return;
    const r = (event.target as Element).getBoundingClientRect();
    Object.assign(outline.style, { display: "block", left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  }, true);
  document.addEventListener("click", (event) => {
    if (!picking) return;
    event.preventDefault();
    event.stopPropagation();
    const el = event.target as Element;
    const capture = document.querySelector("[data-clipmunk-capture]")!.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const scale = capture.width / bridge()!.width;
    post({
      type: "picked",
      selector: selectorFor(el),
      text: el.textContent?.trim().slice(0, 40),
      rect: { x: (r.left - capture.left) / scale, y: (r.top - capture.top) / scale, w: r.width / scale, h: r.height / scale },
    });
  }, true);

  window.addEventListener("message", (event) => {
    if (event.origin !== STUDIO || event.data?.cm !== 1) return;
    const m = event.data;
    if (m.type === "seek") { playing = false; pending = { t: m.t, seq: m.seq }; if (busy) dropped++; void drain(); }
    if (m.type === "play") void play(m.from ?? 0, m.rate ?? 1);
    if (m.type === "pause") playing = false;
    if (m.type === "pick") { picking = !!m.on; outline.style.display = "none"; }
    if (m.type === "permissions") {
      const policy = (document as unknown as { featurePolicy?: { allowsFeature(f: string): boolean } }).featurePolicy;
      post({ type: "permissions", microphone: policy?.allowsFeature("microphone"), autoplay: policy?.allowsFeature("autoplay"), camera: policy?.allowsFeature("camera") });
    }
  });
}
