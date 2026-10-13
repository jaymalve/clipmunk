"use client";

import { type RefObject, useEffect, useState } from "react";

/** The frame every slide is drawn at; each slide is then scaled to whatever room the page gives it. */
export const FRAME = { width: 1440, height: 900 };

/** How much to scale the frame so it exactly fills `box`'s width. */
export function useFit(box: RefObject<HTMLElement | null>) {
  const [scale, setScale] = useState(0);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setScale(el.clientWidth / FRAME.width);
    measure();
    const watcher = new ResizeObserver(measure);
    watcher.observe(el);
    return () => watcher.disconnect();
  }, [box]);

  return scale;
}

export const prefersStillness = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
