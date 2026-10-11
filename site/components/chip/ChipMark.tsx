import { MARK, VIEWBOX } from "./geometry";

/** The logo, untouched: a flat silhouette with no eye and no moving parts. Decorative; label the link around it. */
export default function ChipMark({ className = "" }: { className?: string }) {
  return (
    <svg viewBox={VIEWBOX} className={className} aria-hidden="true">
      <path d={MARK} fill="currentColor" fillRule="evenodd" />
    </svg>
  );
}
