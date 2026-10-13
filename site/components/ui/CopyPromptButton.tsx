"use client";

import { useEffect, useState } from "react";
import { AGENT_PROMPT } from "@/lib/agentPrompt";

/** Clipboard access needs a secure page; on plain http the old selection trick still works. */
async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    const done = document.execCommand("copy");
    area.remove();
    return done;
  }
}

/** Copies the setup prompt for a coding agent, and shows a tick for two seconds once it has. */
export default function CopyPromptButton({ className = "" }: { className?: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      className={`btn btn--munk prompt ${copied ? "is-copied" : ""} ${className}`}
      onClick={async () => setCopied(await copy(AGENT_PROMPT))}
      aria-label="Copy the coding-agent prompt"
    >
      Copy agent prompt
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
    </button>
  );
}
