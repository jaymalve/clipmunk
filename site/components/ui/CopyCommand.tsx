"use client";

import { SITE } from "@/lib/site";
import CopyMark, { useCopy } from "./CopyMark";

/** The install command as a button: click it and the command is on the clipboard. */
export default function CopyCommand({ className = "" }: { className?: string }) {
  const { copied, copy } = useCopy(SITE.install);

  return (
    <button
      type="button"
      className={`btn prompt command mono ${copied ? "is-copied" : ""} ${className}`}
      onClick={copy}
      aria-label={`Copy the command: ${SITE.install}`}
    >
      <span className="command__sign" aria-hidden="true">
        $
      </span>
      {SITE.install}
      <CopyMark copied={copied} />
    </button>
  );
}
