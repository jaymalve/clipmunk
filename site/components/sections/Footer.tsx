import ChipMark from "@/components/chip/ChipMark";
import { SITE } from "@/lib/site";

const COLUMNS = [
  {
    title: "Product",
    links: [
      { href: "#take", label: "A take, replayed" },
      { href: "#uses", label: "Use cases" },
      { href: "#directed", label: "Scenes" },
      { href: "#how", label: "How it works" },
    ],
  },
  {
    title: "More",
    links: [
      { href: "#local", label: "Manners" },
      { href: "#faq", label: "FAQ" },
      { href: SITE.github, label: "GitHub" },
      { href: "#early-access", label: "Early access" },
    ],
  },
];

export default function Footer() {
  return (
    <footer className="foot">
      <div className="wrap">
        <div className="foot__top">
          <div className="foot__about">
            <a href="#top" className="foot__brand">
              <ChipMark className="foot__mark" />
              clipmunk
            </a>
            <p className="foot__tag">{SITE.tagline}</p>
          </div>
          {COLUMNS.map((column) => (
            <div key={column.title} className="foot__col">
              <h3>{column.title}</h3>
              {column.links.map((link) => (
                <a key={link.label} href={link.href}>
                  {link.label}
                </a>
              ))}
            </div>
          ))}
        </div>
        <div className="foot__base">
          <span>© 2026 Clipmunk</span>
        </div>
      </div>
    </footer>
  );
}
