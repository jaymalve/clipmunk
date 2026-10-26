import type { TakeEvent } from "./take";

/** A take's event log as lines an agent can read: when the page changed, what was clicked (with
 * the element's role, name and selector), where typing happened and for how long, and which
 * shortcuts were pressed. Pointer moves and scrolling are left out; typed text was never logged.
 */
const seconds = (ms: number) => `${(ms / 1000).toFixed(2)}s`;

export function summarizeEvents(events: readonly TakeEvent[]): string[] {
  const lines: string[] = [];
  let typing: { t: number; last: number; keys: number; where: string } | undefined;
  let focused = "a field";
  const flush = () => {
    if (!typing) return;
    lines.push(
      `${seconds(typing.t)} typed ${typing.keys} keys in ${typing.where} over ${seconds(typing.last - typing.t)}`,
    );
    typing = undefined;
  };
  for (const event of [...events].sort((a, b) => a.t - b.t)) {
    if (typing && (event.k !== "type" || event.t - typing.last > 1500)) flush();
    switch (event.k) {
      case "route":
        lines.push(`${seconds(event.t)} page ${event.path}`);
        break;
      case "down": {
        const el = event.el;
        const what = el
          ? [el.role ?? "element", el.name ? `"${el.name}"` : undefined, `(${el.sel})`].filter(Boolean).join(" ")
          : `at ${Math.round(event.x)},${Math.round(event.y)}`;
        lines.push(`${seconds(event.t)} click ${what}`);
        break;
      }
      case "focus":
        if (event.el)
          focused = [event.el.role ?? "field", event.el.name ? `"${event.el.name}"` : undefined]
            .filter(Boolean)
            .join(" ");
        break;
      case "type":
        if (typing) {
          typing.keys++;
          typing.last = event.t;
        } else typing = { t: event.t, last: event.t, keys: 1, where: focused };
        break;
      case "combo":
        lines.push(`${seconds(event.t)} shortcut ${event.keys.join("+")}`);
        break;
    }
  }
  flush();
  return lines;
}
