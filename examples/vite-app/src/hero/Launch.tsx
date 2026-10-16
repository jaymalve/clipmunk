import { Surface, useSceneTime } from "clipmunk";
import type { CSSProperties, ReactNode } from "react";
import { MARK, VIEWBOX } from "../../../../site/components/chip/geometry";
import { DashboardScene } from "../../../../site/demo/DashboardScene";
import { PullRequest } from "../../../../site/demo/PullRequest";
import "../../../../site/demo/demo.css";
import "./launch.css";

/*
 * Clipmunk's launch video, made with Clipmunk. Every beat is a scene: Surfaces that the recipe moves
 * (the window, the app inside it, the cards), and host components that read scene time (captions,
 * typing, counters, the cursor). 1920 x 1080 throughout.
 */

const WINDOW = { left: 349, top: 232, width: 1222, bar: 36, height: 800 };
const CONTENT = { width: WINDOW.width, height: WINDOW.height - WINDOW.bar };

const clamp = (value: number) => Math.min(1, Math.max(0, value));
const settle = (value: number) => 1 - (1 - clamp(value)) ** 3;
const smooth = (value: number) => {
  const t = clamp(value);
  return t * t * (3 - 2 * t);
};

/** Words that rise into place one after another, the way launch videos set their captions. */
function Words({
  text,
  from = 150,
  every = 80,
  accent = [],
}: {
  text: string;
  from?: number;
  every?: number;
  accent?: string[];
}) {
  const time = useSceneTime();
  // Each word keeps its place in the line as its identity; a caption never reorders.
  const words = text.split(" ").map((word, place) => ({ word, id: `${place}:${word}` }));
  return (
    <span className="lv-words">
      {words.map(({ word, id }, index) => {
        const shown = settle((time - from - index * every) / 420);
        return (
          <span
            key={id}
            className={accent.includes(word) ? "is-munk" : undefined}
            style={{ opacity: shown, transform: `translateY(${(1 - shown) * 22}px)` }}
          >
            {index ? ` ${word}` : word}
          </span>
        );
      })}
    </span>
  );
}

/** How much of `text` has been typed by now, at `perSecond` characters a second from `from`. */
function useTyped(text: string, from: number, perSecond: number) {
  const time = useSceneTime();
  return text.slice(0, Math.max(0, Math.floor(((time - from) / 1000) * perSecond)));
}

function Stage({ children }: { children: ReactNode }) {
  return (
    <Surface id="stage" style={{ width: 1920, height: 1080 }} content={<div className="lv__bg" />}>
      <div className="lv">{children}</div>
    </Surface>
  );
}

function Caption({ text, accent }: { text: string; accent?: string[] }) {
  return (
    <Surface id="caption" style={{ position: "absolute", left: 0, top: 84, width: 1920 }}>
      <p className="lv__caption">
        <Words text={text} accent={accent} />
      </p>
    </Surface>
  );
}

/** A window with traffic lights; the bar is its own Surface so a zoomed app can never cover it. */
function Window({ title, children }: { title: string; children: ReactNode }) {
  const box: CSSProperties = {
    position: "absolute",
    left: WINDOW.left,
    top: WINDOW.top,
    width: WINDOW.width,
    height: WINDOW.height,
    overflow: "hidden",
    borderRadius: 18,
  };
  return (
    <Surface id="window" style={box} content={<div className="lv__chrome" />}>
      <Surface
        id="app"
        style={{ position: "absolute", left: 0, top: WINDOW.bar, width: CONTENT.width, height: CONTENT.height }}
      >
        {children}
      </Surface>
      <Surface id="bar" style={{ position: "absolute", left: 0, top: 0, width: WINDOW.width, height: WINDOW.bar }}>
        <p className="lv__bar">
          <i />
          <i />
          <i />
          {title}
        </p>
      </Surface>
    </Surface>
  );
}

type Line = { at: number; text: string; kind?: "prompt" | "dim" | "ok" | "dot" | "bar"; type?: number };

function Terminal({ lines }: { lines: Line[] }) {
  const time = useSceneTime();
  const typing = lines.find(
    (line) => line.type && time >= line.at && time < line.at + (line.text.length / line.type) * 1000,
  );
  return (
    <div className="lv-term">
      {lines
        .filter((line) => time >= line.at)
        .map((line) => {
          const text = line.type ? line.text.slice(0, Math.floor(((time - line.at) / 1000) * line.type)) : line.text;
          return (
            <div key={line.at} className={line.kind ? `is-${line.kind}` : undefined}>
              {line.kind === "prompt" ? (
                <>
                  <b>›</b> {text}
                </>
              ) : (
                text
              )}
              {line === typing && <span className="lv-term__caret" />}
            </div>
          );
        })}
    </div>
  );
}

/* ── Cards ─────────────────────────────────────────────────── */

function Mark() {
  return (
    <svg viewBox={VIEWBOX} aria-hidden="true">
      <path d={MARK} fill="currentColor" fillRule="evenodd" />
    </svg>
  );
}

function Card({ children }: { children: ReactNode }) {
  return (
    <Stage>
      <Surface id="card" style={{ position: "absolute", left: 0, top: 0, width: 1920, height: 1080 }}>
        <div className="lv-card">{children}</div>
      </Surface>
    </Stage>
  );
}

export function OpenCard() {
  return (
    <Card>
      <p className="lv-card__brand">
        <Mark />
        <Words text="clipmunk" from={250} />
      </p>
    </Card>
  );
}

export function TitleCard() {
  return (
    <Card>
      <p className="lv-card__title">
        <Words text="Product videos," from={150} every={110} />
        <br />
        <Words text="made from your real UI." from={450} every={110} accent={["real", "UI."]} />
      </p>
    </Card>
  );
}

export function EndCard() {
  return (
    <Card>
      <p className="lv-card__brand">
        <Mark />
        <Words text="clipmunk" from={100} />
      </p>
      <p className="lv-card__pill">
        <span>$</span>
        <Words text="npm install clipmunk" from={600} every={60} />
      </p>
      <p className="lv-card__note">
        <Words text="clipmunk.dev" from={1100} />
      </p>
    </Card>
  );
}

/* ── 1. The prompt ─────────────────────────────────────────── */

export function PromptBeat() {
  return (
    <Stage>
      <Caption text="Paste one prompt." />
      <Window title="acme — agent">
        <Terminal
          lines={[
            { at: 0, text: "~/acme  main", kind: "dim" },
            { at: 400, text: "Set up Clipmunk in this app and make its first clip.", kind: "prompt", type: 46 },
            { at: 1800, text: "● Installing clipmunk", kind: "dot" },
            { at: 2150, text: "● Running npx clipmunk init", kind: "dot" },
            { at: 2500, text: "  ✓ Connected the Vite app · src/main.tsx", kind: "ok" },
            { at: 2900, text: "● Reading CLIPMUNK.md and the guide", kind: "dot" },
            { at: 3300, text: "● Writing src/clipmunk/scenes/launch.scene.json", kind: "dot" },
          ]}
        />
      </Window>
    </Stage>
  );
}

/* ── 2. The scene file ─────────────────────────────────────── */

type Token = [kind: "k" | "s" | "n" | "p", text: string];
const k = (text: string): Token => ["k", `"${text}"`];
const s = (text: string): Token => ["s", `"${text}"`];
const n = (value: number): Token => ["n", String(value)];
const p = (text: string): Token => ["p", text];

const RECIPE: Token[][] = [
  [p("{")],
  [p("  "), k("id"), p(": "), s("launch"), p(",")],
  [p("  "), k("camera"), p(": { "), k("rotateY"), p(": "), n(-26), p(", "), k("rotateX"), p(": "), n(12), p(" },")],
  [p("  "), k("focus"), p(": { "), k("fStop"), p(": "), n(2.2), p(", "), k("focalLength"), p(": "), n(100), p(" },")],
  [p("  "), k("nodes"), p(": ["), s("header"), p(", "), s("stats"), p(", "), s("chart"), p("],")],
  [p("  "), k("motion"), p(": {")],
  [p("    "), k("durationMs"), p(": "), n(4600), p(",")],
  [
    p("    "),
    k("tracks"),
    p(": [{ "),
    k("target"),
    p(": "),
    s("chart"),
    p(", "),
    k("property"),
    p(": "),
    s("z"),
    p(","),
  ],
  [p("      "), k("keyframes"), p(": [{ "), k("timeMs"), p(": "), n(0), p(", "), k("value"), p(": "), n(180), p(" },")],
  [p("                  { "), k("timeMs"), p(": "), n(2300), p(", "), k("value"), p(": "), n(0), p(" }] }]")],
  [p("  },")],
  [p("  "), k("music"), p(": { "), k("style"), p(": "), s("launch"), p(" }")],
  [p("}")],
];

/** The recipe types itself out, one character at a time, across all its lines in order. */
function Recipe() {
  const time = useSceneTime();
  let budget = Math.max(0, Math.floor(((time - 300) / 1000) * 190));
  return (
    <div className="lv-code">
      <p className="lv-code__tabs">
        <span>launch.scene.json</span>
      </p>
      <pre className="lv-code__body">
        {RECIPE.map((line, row) => {
          const shown: Token[] = [];
          for (const [kind, text] of line) {
            if (budget <= 0) break;
            shown.push([kind, text.slice(0, budget)]);
            budget -= text.length;
          }
          if (!shown.length && row > 0) return null;
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: the lines never reorder
            <span key={row} className="lv-code__line">
              <i>{row + 1}</i>
              {shown.map(([kind, text], column) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the tokens never reorder
                <span key={column} className={`tok-${kind}`}>
                  {text}
                </span>
              ))}
              {"\n"}
            </span>
          );
        })}
      </pre>
    </div>
  );
}

export function EditorBeat() {
  return (
    <Stage>
      <Caption text="Your agent directs the shot." />
      <Window title="src/clipmunk/scenes — acme">
        <Recipe />
      </Window>
    </Stage>
  );
}

/* ── 3. The scene itself ───────────────────────────────────── */

function DashboardShot() {
  const time = useSceneTime();
  return <DashboardScene Surface={Surface} progress={(time - 1400) / 2400} />;
}

export function SceneBeat() {
  return (
    <Stage>
      <Caption text="Clipmunk films your real components." accent={["real"]} />
      <Surface id="app" style={{ position: "absolute", left: 240, top: 250, width: 1440, height: 900 }}>
        <DashboardShot />
      </Surface>
    </Stage>
  );
}

/* ── 4. A recorded take ────────────────────────────────────── */

type Waypoint = [timeMs: number, x: number, y: number];
/** The pointer holds still on each button through its click (CLICKS), then moves on. */
const PATH: Waypoint[] = [
  [0, 1150, 720],
  [700, 395, 197],
  [1000, 395, 197],
  [1500, 600, 420],
  [2300, 1004, 564],
  [2900, 969, 564],
  [3450, 969, 564],
  [4300, 1180, 730],
];
const CLICKS = [900, 2500, 3300];

/** Where the smoothed cursor is: eased from waypoint to waypoint, never a straight mechanical line. */
function cursorAt(time: number) {
  const next = PATH.findIndex(([at]) => at > time);
  if (next === -1) return PATH[PATH.length - 1]!;
  if (next === 0) return PATH[0]!;
  const [fromAt, fromX, fromY] = PATH[next - 1]!;
  const [toAt, toX, toY] = PATH[next]!;
  const t = smooth((time - fromAt) / (toAt - fromAt));
  return [time, fromX + (toX - fromX) * t, fromY + (toY - fromY) * t] as Waypoint;
}

function Recording() {
  const time = useSceneTime();
  const state = {
    tab: time >= CLICKS[0]! ? ("files" as const) : ("conversation" as const),
    approved: time >= CLICKS[1]!,
    merged: time >= CLICKS[2]!,
  };
  return (
    <div className="lv__fit">
      <PullRequest {...state} />
    </div>
  );
}

function Pointer() {
  const time = useSceneTime();
  const [, x, y] = cursorAt(time);
  // A ripple stays where the click happened, even as the pointer moves on.
  const click = CLICKS.find((at) => time >= at && time < at + 650);
  const ripple = click === undefined ? undefined : (time - click) / 650;
  const [, clickX, clickY] = cursorAt(click ?? time);
  return (
    <div className="lv-cursor" style={{ transform: "scale(0.8489)", transformOrigin: "0 0" }}>
      {ripple !== undefined && (
        <b style={{ left: clickX, top: clickY, opacity: 1 - ripple, transform: `scale(${0.4 + ripple * 1.1})` }} />
      )}
      <svg viewBox="0 0 20 22" style={{ left: x, top: y }} aria-hidden="true">
        <path d="M2 1.5v16l4.4-3.9 2.9 6.6 2.7-1.2-2.9-6.5h6.1z" />
      </svg>
    </div>
  );
}

function Rec() {
  const time = useSceneTime();
  const seconds = Math.floor(time / 1000);
  return (
    <p className="lv-rec">
      <i style={{ opacity: Math.floor(time / 500) % 2 ? 0.35 : 1 }} /> REC 0:0{seconds}
    </p>
  );
}

export function TakeBeat() {
  return (
    <Stage>
      <Caption text="Or record it yourself." />
      <Window title="localhost:5173/pulls/312">
        <Surface
          id="screen"
          style={{ position: "absolute", left: 0, top: 0, width: CONTENT.width, height: CONTENT.height }}
        >
          <Recording />
        </Surface>
        <Surface
          id="cursor"
          style={{ position: "absolute", left: 0, top: 0, width: CONTENT.width, height: CONTENT.height }}
        >
          <Pointer />
        </Surface>
      </Window>
      <Surface id="rec" style={{ position: "absolute", left: WINDOW.left + WINDOW.width - 170, top: WINDOW.top - 58 }}>
        <Rec />
      </Surface>
    </Stage>
  );
}

/* ── 5. The soundtrack ─────────────────────────────────────── */

const BEAT_MS = 60_000 / 118;
const BARS = Array.from({ length: 58 }, (_, place) => ({
  id: `bar-${place}`,
  height: 0.25 + 0.75 * Math.abs(Math.sin(place * 1.7) * Math.cos(place * 0.37)),
}));

function Bars() {
  const time = useSceneTime();
  const hit = Math.exp(-(time % BEAT_MS) / 170);
  return (
    <div>
      <div className="lv-bars">
        {BARS.map(({ id, height }, index) => {
          const wave = 0.55 + 0.45 * Math.sin(time / 260 + index * 0.45);
          const grown = settle((time - index * 12) / 500);
          return (
            <i key={id} style={{ height: `${Math.max(6, 400 * height * (0.35 + 0.65 * hit) * wave * grown)}px` }} />
          );
        })}
      </div>
      <p className="lv-bars__label">upbeat · 118 bpm · generated on your machine, yours to use</p>
    </div>
  );
}

export function MusicBeat() {
  return (
    <Stage>
      <Caption text="Scored in code." />
      <Surface id="bars" style={{ position: "absolute", left: 0, top: 360, width: 1920 }}>
        <Bars />
      </Surface>
    </Stage>
  );
}

/* ── 6. The export ─────────────────────────────────────────── */

function Progress() {
  const time = useSceneTime();
  const done = smooth((time - 1500) / 1500);
  if (time < 1500) return null;
  const filled = Math.round(done * 32);
  return (
    <div>
      <span className="lv-term__bar">{"█".repeat(filled)}</span>
      <span className="is-dim">{"░".repeat(32 - filled)}</span> {Math.round(done * 100)}%
    </div>
  );
}

export function ExportBeat() {
  const command = useTyped("npx clipmunk export --sequence launch", 200, 40);
  const time = useSceneTime();
  return (
    <Stage>
      <Caption text="Out comes an MP4." />
      <Window title="acme — zsh">
        <div className="lv-term">
          <div className="is-prompt">
            <b>$</b> {command}
            {time < 1300 && <span className="lv-term__caret" />}
          </div>
          {time >= 1300 && <div className="is-dim">Rendering 9 scenes at 1920×1080, 60 fps</div>}
          <Progress />
          {time >= 3100 && <div className="is-ok">✓ Wrote launch.mp4 · 1920×1080 · 60 fps · 0:32</div>}
        </div>
      </Window>
    </Stage>
  );
}
