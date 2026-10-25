import { type RedactionTrack, redactionTrack } from "./redact";
import type { Caption, ElementIdentity, TakeEdit, TakeEvent } from "./take";

/** Captions that say what the user did ("Click New invoice"), generated from the event log.
 * Like auto-zoom, generation is pure and deterministic, and its output is ordinary data:
 * one caption per burst of activity, phrased from the first named control clicked in it.
 * A control is named only when the recorder logged its accessible name, which it never does
 * inside a redaction selector; a click inside a redacted box is skipped as well.
 */

/** Activity closer together than this is one burst, and gets one caption. */
export const CAPTION_GAP_MS = 2500;
/** A caption appears this long before its click, stays at least MIN_MS, and lingers TAIL_MS after the burst. */
const LEAD_MS = 300,
  MIN_MS = 1800,
  TAIL_MS = 1000,
  /** Gap kept between one caption's end and the next one's start. */
  SPACING_MS = 100,
  FADE_MS = 150,
  MAX_NAME = 60;

const FIELDS = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);
const VERBS: Record<string, string> = {
  link: "Open",
  menuitem: "Open",
  tab: "Open",
  radio: "Choose",
  option: "Choose",
  menuitemradio: "Choose",
  checkbox: "Toggle",
  menuitemcheckbox: "Toggle",
  switch: "Toggle",
};

/** "Click New invoice", "Open Settings", "Choose Monthly", "Type in Search". */
export function phraseFor(el: ElementIdentity, typed: boolean): string | undefined {
  const name = el.name?.replace(/\s+/g, " ").trim();
  if (!name) return undefined;
  const short = name.length > MAX_NAME ? `${name.slice(0, MAX_NAME - 1).trimEnd()}…` : name;
  const role = el.role ?? "";
  const verb = FIELDS.has(role) ? (typed ? "Type in" : "Click") : (VERBS[role] ?? "Click");
  return `${verb} ${short}`;
}

type Down = Extract<TakeEvent, { k: "down" }>;

export function generateCaptions(events: readonly TakeEvent[], redaction?: RedactionTrack): Caption[] {
  const activity = events.filter((event) => event.k === "down" || event.k === "type").sort((a, b) => a.t - b.t);
  const bursts: (typeof activity)[] = [];
  for (const event of activity) {
    const current = bursts.at(-1);
    if (current && event.t - current.at(-1)!.t <= CAPTION_GAP_MS) current.push(event);
    else bursts.push([event]);
  }
  const hidden = (down: Down) =>
    !!redaction
      ?.at(down.t)
      .some(({ rect: [x, y, w, h] }) => down.x >= x && down.x <= x + w && down.y >= y && down.y <= y + h);

  const captions: Caption[] = [];
  for (const burst of bursts) {
    let phrase: string | undefined, at: number | undefined;
    for (const [index, event] of burst.entries()) {
      if (event.k !== "down" || !event.el || hidden(event)) continue;
      const typed = burst.slice(index + 1).some((later) => later.k === "type");
      phrase = phraseFor(event.el, typed);
      if (phrase) {
        at = event.t;
        break;
      }
    }
    if (!phrase || at === undefined) continue;
    const atMs = Math.max(0, at - LEAD_MS);
    captions.push({ atMs, durMs: Math.max(MIN_MS, burst.at(-1)!.t + TAIL_MS - atMs), text: phrase, source: "auto" });
  }
  // A caption gives way to the next one.
  for (const [index, caption] of captions.entries()) {
    const next = captions[index + 1];
    if (next) caption.durMs = Math.max(FADE_MS * 2, Math.min(caption.durMs, next.atMs - SPACING_MS - caption.atMs));
  }
  return captions;
}

const overlaps = (a: Caption, b: Caption) => a.atMs < b.atMs + b.durMs && b.atMs < a.atMs + a.durMs;

/** The captions a take shows, in time order. With `auto` on, generated captions are recomputed
 * and manual items replace the generated ones they overlap; with it off, the stored items are
 * shown as they are. Items with empty text show nothing; the editor asks for them with `keepEmpty`
 * so a caption being retyped keeps its field.
 */
export function resolveCaptions(
  edit: Pick<TakeEdit, "captions" | "redact">,
  events: readonly TakeEvent[],
  options: { keepEmpty?: boolean } = {},
): Caption[] {
  const { auto, items } = edit.captions;
  let list: Caption[];
  if (auto) {
    const manual = items.filter((item) => item.source === "manual");
    const generated = generateCaptions(events, redactionTrack(events, edit.redact));
    list = [...manual, ...generated.filter((caption) => !manual.some((item) => overlaps(item, caption)))];
  } else list = [...items];
  return list.filter((caption) => options.keepEmpty || caption.text.trim()).sort((a, b) => a.atMs - b.atMs);
}

/** The caption showing at a time, with its opacity as it fades in and out. A later caption wins. */
export function captionAt(captions: readonly Caption[], timeMs: number): { text: string; opacity: number } | undefined {
  for (let index = captions.length - 1; index >= 0; index--) {
    const caption = captions[index]!;
    const age = timeMs - caption.atMs;
    if (age < 0 || age >= caption.durMs) continue;
    const opacity = Math.min(1, age / FADE_MS, (caption.durMs - age) / FADE_MS);
    return { text: caption.text, opacity };
  }
  return undefined;
}
