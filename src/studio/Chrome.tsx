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
