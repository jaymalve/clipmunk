"use client";

import { type ElementType, type ReactNode, useEffect, useRef, useState } from "react";

/** Adds `is-in` once the element scrolls into view, so CSS can run entrance animations. */
export default function InView({
  as: Tag = "div",
  className = "",
  threshold = 0.25,
  children,
  id,
}: {
  as?: ElementType;
  className?: string;
  threshold?: number;
  children: ReactNode;
  id?: string;
}) {
  const ref = useRef<HTMLElement>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setInView(true);
          io.disconnect();
        }
      },
      { threshold },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [threshold]);

  return (
    <Tag ref={ref} id={id} className={`${className} ${inView ? "is-in" : ""}`}>
      {children}
    </Tag>
  );
}
