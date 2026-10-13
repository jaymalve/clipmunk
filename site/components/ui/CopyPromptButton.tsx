"use client";

import { AGENT_PROMPT } from "@/lib/agentPrompt";
import CopyMark, { useCopy } from "./CopyMark";
import { ClaudeCodeLogo, CursorLogo, OpenAILogo, OpenCodeLogo } from "./Logos";

/** Copies the setup prompt for a coding agent, and shows a tick for two seconds once it has. */
export default function CopyPromptButton({ className = "" }: { className?: string }) {
  const { copied, copy } = useCopy(AGENT_PROMPT);

  return (
    <button
      type="button"
      className={`btn btn--munk prompt ${copied ? "is-copied" : ""} ${className}`}
      onClick={copy}
      aria-label="Copy the coding-agent prompt"
    >
      <span className="prompt__agents">
        <OpenAILogo className="prompt__openai" />
        <ClaudeCodeLogo className="prompt__claude" />
        <CursorLogo className="prompt__cursor" />
        <OpenCodeLogo className="prompt__opencode" />
      </span>
      Copy agent prompt
      <CopyMark copied={copied} />
    </button>
  );
}
