"use client";

import { type CSSProperties, type KeyboardEvent, type MouseEvent, useEffect, useId, useRef, useState } from "react";
import { trackEye } from "./eyes";
import { BODY, EAR, EYE, TAIL, VIEWBOX, VIEWBOX_WIDE } from "./geometry";
import { poke } from "./sound";

export type ChipEye = "open" | "happy" | "closed" | "wide";
/** munk = brand orange (default), ink = near black, paper = white, ghost = faint white */
export type ChipVariant = "munk" | "ink" | "paper" | "ghost";
export type ChipProp = "none" | "clapper" | "acorn" | "headphones";
export type ChipMotion = "idle" | "float" | "run" | "still";

type Props = {
  variant?: ChipVariant;
  eye?: ChipEye;
  prop?: ChipProp;
  motion?: ChipMotion;
  /** the glint in the eye follows the pointer */
  track?: boolean;
  /** click to squeak */
  interactive?: boolean;
  flip?: boolean;
  pitch?: number;
  className?: string;
  style?: CSSProperties;
  title?: string;
  onPoke?: () => void;
};

function hash(text: string) {
  let value = 0;
  for (let index = 0; index < text.length; index++) value = (value * 31 + text.charCodeAt(index)) | 0;
  return Math.abs(value);
}

function Eye({ eye }: { eye: ChipEye }) {
  const { cx, cy, r } = EYE;
  if (eye === "happy" || eye === "closed") {
    const lift = eye === "happy" ? -r : r * 0.5;
    return (
      <path
        className="chip__lid"
        d={`M ${cx - r} ${cy + 3} Q ${cx} ${cy + 3 + lift} ${cx + r} ${cy + 3}`}
        fill="none"
        strokeWidth="9"
        strokeLinecap="round"
      />
    );
  }
  const radius = eye === "wide" ? r * 1.25 : r;
  return (
    <g className="chip__eye">
      <circle className="chip__ball" cx={cx} cy={cy} r={radius} />
      <circle className="chip__glint" cx={cx + 4} cy={cy - 5} r={radius * 0.32} />
    </g>
  );
}

function Clapper() {
  return (
    <g className="chip__prop chip__clapper">
      <rect className="chip__slate" x="930" y="668" width="250" height="170" rx="16" />
      <g className="chip__stick">
        <rect className="chip__slate" x="930" y="622" width="250" height="40" rx="10" />
        <path
          className="chip__stripe"
          d="M 962 622 l 34 0 l -24 40 l -34 0 z M 1040 622 l 34 0 l -24 40 l -34 0 z M 1118 622 l 34 0 l -24 40 l -34 0 z"
        />
      </g>
      <path className="chip__rule" d="M 956 724 h 198 M 956 766 h 120 M 956 804 h 160" />
    </g>
  );
}

function Acorn() {
  return (
    <g className="chip__prop chip__acorn">
      <path className="chip__nut" d="M 932 690 c 0 46 22 78 46 78 c 24 0 46 -32 46 -78 z" />
      <path className="chip__cap" d="M 922 692 c 0 -34 26 -52 56 -52 c 30 0 56 18 56 52 z" />
      <path className="chip__stem" d="M 978 642 q 2 -18 14 -24" />
    </g>
  );
}

function Headphones() {
  return (
    <g className="chip__prop chip__phones">
      <path className="chip__band" d="M 842 500 C 800 400, 860 330, 950 372" />
      <rect className="chip__cup" x="812" y="462" width="62" height="92" rx="28" />
    </g>
  );
}

export default function Chip({
  variant = "munk",
  eye = "open",
  prop = "none",
  motion = "idle",
  track = true,
  interactive = true,
  flip = false,
  pitch = 1,
  className = "",
  style,
  title = "Chip",
  onPoke,
}: Props) {
  const uid = useId();
  const ref = useRef<SVGSVGElement>(null);
  const [poked, setPoked] = useState(false);

  useEffect(() => {
    if (!track || !ref.current) return;
    return trackEye(ref.current);
  }, [track]);

  function squeak(x: number, y: number) {
    poke(x, y, pitch);
    onPoke?.();
    setPoked(false);
    requestAnimationFrame(() => setPoked(true));
    window.setTimeout(() => setPoked(false), 560);
  }

  function handleClick(event: MouseEvent<SVGSVGElement>) {
    if (!interactive) return;
    event.stopPropagation();
    squeak(event.clientX, event.clientY);
  }

  function handleKey(event: KeyboardEvent<SVGSVGElement>) {
    if (!interactive || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    const box = event.currentTarget.getBoundingClientRect();
    squeak(box.left + box.width / 2, box.top + box.height / 3);
  }

  const classes = ["chip", `chip--${variant}`, `chip--${motion}`];
  if (interactive) classes.push("chip--interactive");
  if (poked) classes.push("is-poked");
  if (className) classes.push(className);

  return (
    <svg
      ref={ref}
      viewBox={prop === "clapper" ? VIEWBOX_WIDE : VIEWBOX}
      className={classes.join(" ")}
      style={{ "--blink-delay": `${(hash(uid) % 5000) / 1000}s`, ...style } as CSSProperties}
      data-flip={flip ? "1" : "0"}
      role={interactive ? "button" : "img"}
      aria-label={interactive ? `${title} (click me)` : title}
      tabIndex={interactive ? 0 : undefined}
      onClick={handleClick}
      onKeyDown={handleKey}
    >
      <g className="chip__all">
        <path className="chip__tail chip__fur" d={TAIL} />
        <g className="chip__torso">
          <path className="chip__ear chip__fur" d={EAR} />
          <path className="chip__fur" d={BODY} />
          {variant !== "ghost" && <Eye eye={eye} />}
          {prop === "headphones" && <Headphones />}
        </g>
        {prop === "clapper" && <Clapper />}
        {prop === "acorn" && <Acorn />}
      </g>
    </svg>
  );
}
