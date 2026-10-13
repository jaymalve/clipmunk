"use client";

import { useEffect, useState } from "react";
import { copyText } from "@/lib/copy";

/** Copies `text` when asked, and reports "copied" for two seconds afterwards. */
export function useCopy(text: string) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return { copied, copy: async () => setCopied(await copyText(text)) };
}

/** The copy mark that turns into a tick, with the word a screen reader hears when it does. */
export default function CopyMark({ copied }: { copied: boolean }) {
  return (
    <>
      <svg className="prompt__state" viewBox="0 0 20 20" aria-hidden="true">
        <g className="prompt__copy">
          <rect x="7" y="7" width="9" height="9" rx="2" />
          <path d="M13 7V5.5A1.5 1.5 0 0 0 11.500 4h-6A1.500 1.500 0 0 0 4 5.500v6A1.500 1.500 0 0 0 5.500 13H7" />
        </g>
        <path className="prompt__tick" d="M5 10.500l3.200 3.200L15 7" />
      </svg>
      <span className="sr-only" role="status">
        {copied ? "Copied" : ""}
      </span>
    </>
  );
}
