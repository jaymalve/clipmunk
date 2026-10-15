"use client";

import { useState } from "react";
import ChipMark from "@/components/chip/ChipMark";
import { SITE } from "@/lib/site";
import { GitHubLogo } from "./Logos";

const LINKS = [
  { href: "#take", label: "A take" },
  { href: "#uses", label: "Use cases" },
  { href: "#directed", label: "Scenes" },
  { href: "#how", label: "How it works" },
  { href: "#faq", label: "FAQ" },
];

export default function Nav() {
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
          <a href={SITE.github} className="nav__plain nav__github" aria-label="Clipmunk on GitHub">
            <GitHubLogo />
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
