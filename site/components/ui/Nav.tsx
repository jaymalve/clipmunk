"use client";

import { useState, useSyncExternalStore } from "react";
import ChipMark from "@/components/chip/ChipMark";
import { isMuted, setMuted, subscribeMute } from "@/components/chip/sound";
import { SITE } from "@/lib/site";

const LINKS = [
  { href: "#take", label: "A take" },
  { href: "#uses", label: "Use cases" },
  { href: "#directed", label: "Scenes" },
  { href: "#how", label: "How it works" },
  { href: "#faq", label: "FAQ" },
];

export default function Nav() {
  const muted = useSyncExternalStore(subscribeMute, isMuted, () => false);
  const [open, setOpen] = useState(false);

  return (
    <header className="nav">
      <div className="nav__in">
        <a href="#top" className="nav__brand" aria-label="Clipmunk home">
          <ChipMark className="nav__mark" />
          <span>clipmunk</span>
        </a>
        <nav className={`nav__links ${open ? "is-open" : ""}`} aria-label="Primary">
          {LINKS.map((link) => (
            <a key={link.href} href={link.href} onClick={() => setOpen(false)}>
              {link.label}
            </a>
          ))}
        </nav>
        <div className="nav__right">
          <button
            type="button"
            className="nav__mute"
            onClick={() => setMuted(!muted)}
            aria-pressed={!muted}
            title={muted ? "Sound is off" : "Sound is on"}
          >
            <span className={`nav__led ${muted ? "" : "is-on"}`} />
            {muted ? "Sound off" : "Sound on"}
          </button>
          <a href={SITE.github} className="nav__plain">
            GitHub
          </a>
          <a href={SITE.npm} className="btn btn--sm btn--munk nav__cta">
            View on npm
          </a>
          <button
            type="button"
            className="nav__burger"
            aria-label="Menu"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            <span />
            <span />
          </button>
        </div>
      </div>
    </header>
  );
}
