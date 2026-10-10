import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Studio UI renders in a shadow root so host CSS cannot restyle it and its CSS cannot leak out.
 * The host element is marked so the exporter can hide all studio chrome in its own page.
 */
const STYLES = `
:host { all: initial; }
* { box-sizing: border-box; }
.bar { font: 13px/1.3 system-ui, sans-serif; color: #f4f4f5; display: flex; align-items: center; gap: 12px;
  padding: 10px 14px; background: rgba(24,24,27,.82); backdrop-filter: blur(14px); border: 1px solid rgba(255,255,255,.1); border-radius: 14px; }
.title { font-weight: 600; white-space: nowrap; }
.time { font-variant-numeric: tabular-nums; color: #a1a1aa; white-space: nowrap; }
button { font: inherit; color: inherit; background: rgba(255,255,255,.1); border: 0; border-radius: 9px; padding: 6px 12px; cursor: pointer; min-width: 64px; }
button:hover:not(:disabled) { background: rgba(255,255,255,.18); }
button:disabled { opacity: .4; cursor: default; }
input[type=range] { flex: 1; min-width: 80px; accent-color: #f4f4f5; }
.issues { font: 13px/1.4 system-ui, sans-serif; color: #fecaca; background: rgba(69,10,10,.9); border: 1px solid rgba(248,113,113,.4);
  border-radius: 12px; padding: 10px 14px; margin-bottom: 8px; max-height: 40vh; overflow: auto; }
.issues strong { color: #fff; } .issues ul { margin: 6px 0 0; padding-left: 18px; } .issues code { color: #fca5a5; }
.empty { font: 15px/1.5 system-ui, sans-serif; color: #a1a1aa; text-align: center; }
a { color: inherit; }
.command { display: flex; gap: 10px; align-items: center; font: 13px/1.4 system-ui, sans-serif; color: #e4e4e7; background: rgba(24,24,27,.92);
  border: 1px solid rgba(255,255,255,.1); border-radius: 12px; padding: 10px 14px; margin-bottom: 8px; }
.command code { flex: 1; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; color: #a5f3fc; overflow-wrap: anywhere; user-select: all; }
.library { font: 15px/1.5 system-ui, sans-serif; color: #e4e4e7; min-height: 100vh; padding: 56px 48px; background: #000; }
.library h1 { margin: 0 0 4px; font-size: 26px; letter-spacing: -.02em; } .library > p { margin: 0 0 28px; color: #a1a1aa; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 18px; }
.tile { display: block; text-decoration: none; border: 1px solid #27272a; border-radius: 14px; overflow: hidden; background: #09090b; }
.tile:hover { border-color: #52525b; }
.thumb { display: grid; place-items: center; aspect-ratio: 10 / 7; background: #000; color: #3f3f46; font-size: 40px; font-weight: 700; }
.thumb img { width: 100%; height: 100%; object-fit: contain; display: block; }
.tile div { padding: 12px 14px 14px; } .tile b { display: block; } .tile span { display: block; color: #a1a1aa; font-size: 13px; margin-top: 2px; }
.command select { font: inherit; color: inherit; background: rgba(255,255,255,.1); border: 0; border-radius: 9px; padding: 6px 8px; }
.library h2 { margin: 40px 0 4px; font-size: 18px; } .library h2 + p { margin: 0 0 18px; color: #a1a1aa; }
.rows { display: grid; gap: 8px; max-width: 760px; }
.row { display: flex; gap: 14px; align-items: baseline; text-decoration: none; padding: 12px 16px; border: 1px solid #27272a; border-radius: 12px; background: #09090b; }
.row:hover { border-color: #52525b; } .row b { flex: 1; } .row span { color: #a1a1aa; font-size: 13px; font-variant-numeric: tabular-nums; }
.take { font: 14px/1.5 system-ui, sans-serif; color: #e4e4e7; min-height: 100vh; padding: 28px 40px; background: #000; display: grid; gap: 16px; align-content: start; }
.take header { display: flex; gap: 16px; align-items: center; } .take h1 { margin: 0; font-size: 20px; flex: 1; }
.take .media { display: flex; gap: 16px; align-items: flex-start; flex-wrap: wrap; }
.take video.screen { max-width: min(100%, 1100px); max-height: 68vh; border-radius: 10px; border: 1px solid #27272a; }
.take video.cam { width: 220px; border-radius: 10px; border: 1px solid #27272a; }
.take dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 18px; margin: 0; color: #a1a1aa; } .take dd { margin: 0; color: #e4e4e7; }
.note { color: #a1a1aa; }
.editor { font: 13px/1.4 system-ui, sans-serif; color: #e4e4e7; height: 100vh; display: grid; grid-template: auto auto minmax(0, 1fr) auto / minmax(0, 1fr) 300px; background: #000; }
.editor header { grid-column: 1 / -1; display: flex; gap: 12px; align-items: center; padding: 12px 18px; border-bottom: 1px solid #18181b; }
.editor header .title { flex: 1; min-width: 0; font: 600 16px system-ui, sans-serif; color: #fafafa; background: none; border: 1px solid transparent; border-radius: 8px; padding: 5px 8px; }
.editor header .title:hover, .editor header .title:focus { border-color: #3f3f46; outline: none; }
.editor .save { color: #71717a; white-space: nowrap; } .editor .save.bad { color: #fca5a5; white-space: normal; max-width: 40vw; }
.editor > .command { grid-column: 1 / -1; grid-row: 2; margin: 10px 18px 0; }
.editor .stage { grid-column: 1; grid-row: 3; min-height: 0; display: grid; place-items: center; padding: 18px; position: relative; }
.editor .stage canvas { max-width: 100%; max-height: 100%; min-height: 0; border-radius: 6px; box-shadow: 0 0 0 1px #27272a; }
.editor .stage .issues, .editor .stage .note { position: absolute; }
.editor aside { grid-column: 2; grid-row: 3; overflow: auto; border-left: 1px solid #18181b; padding: 6px 16px 16px; }
.editor section { padding: 12px 0; border-bottom: 1px solid #18181b; } .editor section:last-child { border: 0; }
.editor h2 { margin: 0 0 8px; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: #a1a1aa; }
.field { display: grid; grid-template-columns: 96px minmax(0, 1fr) 44px; gap: 8px; align-items: center; padding: 4px 0; }
.field output { color: #a1a1aa; font-variant-numeric: tabular-nums; text-align: right; }
.field select, .field input[type=color] { grid-column: 2 / -1; font: inherit; color: inherit; background: #18181b; border: 1px solid #27272a; border-radius: 7px; padding: 4px 6px; width: 100%; }
.field input[type=color] { padding: 2px; height: 28px; } .field input[type=range] { min-width: 0; width: 100%; }
.field.check { grid-template-columns: auto 1fr; } .field.check input { accent-color: #f4f4f5; }
.hint { color: #71717a; margin: 4px 0 0; }
.editor footer { grid-column: 1 / -1; grid-row: 4; padding: 10px 18px 16px; border-top: 1px solid #18181b; display: grid; gap: 10px; }
.transport { display: flex; gap: 10px; align-items: center; } .transport .spacer { flex: 1; } .transport .hint { margin: 0; }
.timeline { position: relative; height: 34px; border-radius: 8px; background: #18181b; cursor: pointer; touch-action: none; overflow: hidden; }
.timeline:focus-visible { outline: 2px solid #a1a1aa; outline-offset: 2px; }
.timeline .kept { position: absolute; top: 0; bottom: 0; background: #3f3f46; }
.timeline .zoom { position: absolute; top: 9px; bottom: 9px; border-radius: 5px; background: #818cf8; opacity: .85; pointer-events: none; }
.timeline .playhead { position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px; background: #fafafa; pointer-events: none; }
.take header .title { flex: 1; min-width: 0; font: 600 18px system-ui, sans-serif; color: #fafafa; background: none; border: 1px solid transparent; border-radius: 8px; padding: 5px 8px; }
.take header .title:hover, .take header .title:focus { border-color: #3f3f46; outline: none; }
.take .save { color: #71717a; } .take .save.bad { color: #fca5a5; max-width: 40vw; }
.sequence { max-width: 860px; } .sequence .command { margin: 0; }
.settings { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; } .settings label { display: flex; gap: 8px; align-items: center; color: #a1a1aa; }
.settings select, .join select, .join input { font: inherit; color: #e4e4e7; background: #18181b; border: 1px solid #27272a; border-radius: 7px; padding: 5px 8px; }
.join input { width: 76px; }
.clips { list-style: none; margin: 0; padding: 0; display: grid; gap: 0; }
.clip { display: flex; gap: 10px; align-items: center; padding: 12px 14px; border: 1px solid #27272a; border-radius: 12px; background: #09090b; } .clip b { flex: 1; }
.clip .kind { font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: #a5b4fc; border: 1px solid #3730a3; border-radius: 999px; padding: 2px 8px; }
.join { display: flex; gap: 10px; align-items: center; padding: 8px 0 8px 22px; margin-left: 22px; border-left: 2px solid #27272a; color: #a1a1aa; }
.new { display: flex; gap: 10px; align-items: center; margin-top: 14px; flex-wrap: wrap; }
.new input, .new select { font: inherit; color: #e4e4e7; background: #18181b; border: 1px solid #27272a; border-radius: 9px; padding: 7px 10px; }
.library code { font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; color: #a5f3fc; }
`;

export function Chrome({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  const host = useRef<HTMLDivElement>(null);
  const [shadow, setShadow] = useState<ShadowRoot | null>(null);
  useLayoutEffect(() => {
    const element = host.current!;
    setShadow(element.shadowRoot ?? element.attachShadow({ mode: "open" }));
  }, []);
  return (
    <div ref={host} data-flick-chrome="" style={style}>
      {shadow &&
        createPortal(
          <>
            <style>{STYLES}</style>
            {children}
          </>,
          shadow,
        )}
    </div>
  );
}
