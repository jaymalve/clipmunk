// Spike: a standalone Studio. Scenes render in iframes of the host app; takes render here,
// using the real TakeEditor, because the compositor needs nothing from the host.
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useDaemon } from "../../../src/studio/daemon";
import { TakeEditor } from "../../../src/studio/TakeEditor";
import { adoptDaemonLink } from "../../../src/recorder/daemon";

const HOST = "http://127.0.0.1:5180";
adoptDaemonLink();
const params = new URLSearchParams(location.search);

type Info = { durationMs: number; width: number; height: number };
type Frame = { el: HTMLIFrameElement; info?: Info; seq: number; acked: number; waiters: Array<{ seq: number; resolve: (v: unknown) => void }> };
const frames: Frame[] = [];
const ticks: number[][] = [];
const events: unknown[] = [];

window.addEventListener("message", (event) => {
  if (event.origin !== HOST || event.data?.cm !== 1) return;
  const index = frames.findIndex((f) => f.el.contentWindow === event.source);
  const frame = frames[index];
  if (!frame) return;
  const m = event.data;
  if (m.type === "ready") { frame.info = m; events.push({ index, ...m }); }
  if (m.type === "frame" || m.type === "error") {
    frame.acked = Math.max(frame.acked, m.seq);
    // Latest wins: a later frame answers every earlier seek too.
    frame.waiters = frame.waiters.filter((w) => (w.seq <= m.seq ? (w.resolve(m), false) : true));
  }
  if (m.type === "tick") (ticks[index] ??= []).push(performance.now());
  if (m.type === "stopped" || m.type === "picked" || m.type === "permissions") events.push({ index, ...m });
  window.dispatchEvent(new CustomEvent("spike", { detail: { index, ...m } }));
});

const send = (frame: Frame, message: object) => frame.el.contentWindow!.postMessage({ cm: 1, ...message }, HOST);
// Measurement hooks for the spike script.
Object.assign(window, {
  spike: {
    frames, ticks, events,
    ready: () => frames.length > 0 && frames.every((f) => f.info),
    seek(t: number, index = 0) {
      const frame = frames[index]!;
      const seq = ++frame.seq;
      send(frame, { type: "seek", t, seq });
      return new Promise((resolve) => frame.waiters.push({ seq, resolve }));
    },
    play: (index = 0, from = 0) => { ticks[index] = []; send(frames[index]!, { type: "play", from }); },
    pause: (index = 0) => send(frames[index]!, { type: "pause" }),
    pick: (on: boolean, index = 0) => send(frames[index]!, { type: "pick", on }),
    permissions: (index = 0) => send(frames[index]!, { type: "permissions" }),
  },
});

function SceneFrames({ scene, count, exact }: { scene: string; count: number; exact: boolean }) {
  const holder = useRef<HTMLDivElement>(null);
  const [time, setTime] = useState(0);
  const [info, setInfo] = useState<Info>();
  const [picked, setPicked] = useState<string>();
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (d.type === "ready") setInfo(d);
      if (d.type === "tick" || d.type === "frame") setTime(d.t);
      if (d.type === "picked") setPicked(`${d.selector} "${d.text}" @ ${JSON.stringify(d.rect)}`);
    };
    window.addEventListener("spike", on);
    return () => window.removeEventListener("spike", on);
  }, []);
  // `size=WxH` gives every frame the same size, so several can sit side by side on screen.
  const fixed = params.get("size")?.split("x").map(Number);
  const sizes = Array.from({ length: count }, (_, i) =>
    exact ? null : fixed ? { w: fixed[0]!, h: fixed[1]! } : i === 1 ? { w: 270, h: 480 } : { w: 640, h: 400 },
  );
  useEffect(() => {
    const box = holder.current!;
    box.innerHTML = "";
    frames.length = 0;
    sizes.forEach((size, i) => {
      const el = document.createElement("iframe");
      el.src = `${HOST}/?clipmunk=1&clipmunk-scene=${scene}&clipmunk-frame=${i}`;
      el.allow = "autoplay; microphone; camera";
      el.title = `frame ${i}`;
      if (size) { el.width = String(size.w); el.height = String(size.h); }
      frames.push({ el, seq: 0, acked: 0, waiters: [] });
      box.append(el);
    });
  }, [scene, count]);
  useEffect(() => {
    // Exact mode: frame at the scene's own size so preview pixels can be compared 1:1.
    if (exact && info) for (const f of frames) { f.el.width = String(info.width); f.el.height = String(info.height); }
  }, [exact, info]);
  const w = window as unknown as { spike: { seek(t: number, i?: number): Promise<unknown>; play(i?: number, from?: number): void; pause(i?: number): void; pick(on: boolean): void } };
  return (
    <>
      <div className="top">
        <a href="/">← Studio</a>
        <b>{scene}</b>
        <button type="button" onClick={() => frames.forEach((_, i) => w.spike.play(i, time))}>Play</button>
        <button type="button" onClick={() => frames.forEach((_, i) => w.spike.pause(i))}>Pause</button>
        <input type="range" min={0} max={info?.durationMs ?? 1} value={time} onChange={(e) => { const t = Number(e.currentTarget.value); setTime(t); frames.forEach((_, i) => void w.spike.seek(t, i)); }} />
        <span>{(time / 1000).toFixed(2)}s / {((info?.durationMs ?? 0) / 1000).toFixed(2)}s</span>
        <button type="button" onClick={() => w.spike.pick(true)}>Pick element</button>
        {picked && <code>{picked}</code>}
      </div>
      <div className="frames" ref={holder} />
    </>
  );
}

function Take({ id }: { id: string }) {
  const daemon = useDaemon();
  if (!daemon) return null;
  return <TakeEditor id={id} daemon={daemon} backHref="/" />;
}

function Home() {
  const daemon = useDaemon();
  const [list, setList] = useState<{ scenes: { id: string }[]; takes: { id: string }[] }>();
  useEffect(() => {
    if (!daemon?.client) return;
    void Promise.all([daemon.client.get<{ scenes: { id: string }[] }>("/v1/scenes"), daemon.client.get<{ takes: { id: string }[] }>("/v1/takes")]).then(([s, t]) =>
      setList({ scenes: s.ok ? s.data.scenes : [], takes: t.ok ? (t.data as unknown as { takes: { id: string }[] }).takes ?? [] : [] }),
    );
  }, [daemon]);
  if (!daemon) return null;
  if (daemon.problem) return <p style={{ padding: 16 }}>No daemon: {JSON.stringify(daemon.problem)}</p>;
  return (
    <div style={{ padding: 16 }}>
      <h2>Scenes</h2>
      {list?.scenes.map((s) => <div key={s.id}><a href={`?scene=${s.id}`}>{s.id}</a> · <a href={`?scene=${s.id}&frames=2`}>2 viewports</a></div>)}
      <h2>Takes</h2>
      {list?.takes.map((t) => <div key={t.id}><a href={`?take=${t.id}`}>{t.id}</a></div>)}
    </div>
  );
}

const scene = params.get("scene");
const take = params.get("take");
createRoot(document.getElementById("root")!).render(
  scene ? <SceneFrames scene={scene} count={Number(params.get("frames") ?? 1)} exact={params.has("exact")} /> : take ? <Take id={take} /> : <Home />,
);
