import { describe, expect, it } from "vitest";
import {
  CAPTION_GAP_MS,
  type Caption,
  captionAt,
  defaultEdit,
  generateCaptions,
  KEY_PILL_MS,
  keyLabel,
  keyPills,
  phraseFor,
  pillsAt,
  redactionTrack,
  resolveCaptions,
  type TakeEvent,
} from "./index";

const down = (t: number, el?: { role?: string; name?: string }, x = 100, y = 100): TakeEvent => ({
  t,
  k: "down",
  x,
  y,
  button: 0,
  rect: [x - 10, y - 10, 20, 20],
  ...(el ? { el: { sel: "#x", ...el } } : {}),
});
const type = (t: number): TakeEvent => ({ t, k: "type", rect: [0, 0, 100, 20] });

describe("caption phrasing", () => {
  it("words a click by the control's role", () => {
    expect(phraseFor({ sel: "#a", role: "button", name: "New invoice" }, false)).toBe("Click New invoice");
    expect(phraseFor({ sel: "#a", role: "link", name: "Settings" }, false)).toBe("Open Settings");
    expect(phraseFor({ sel: "#a", role: "tab", name: "Billing" }, false)).toBe("Open Billing");
    expect(phraseFor({ sel: "#a", role: "radio", name: "Monthly" }, false)).toBe("Choose Monthly");
    expect(phraseFor({ sel: "#a", role: "option", name: "Monthly" }, false)).toBe("Choose Monthly");
    expect(phraseFor({ sel: "#a", role: "switch", name: "Dark mode" }, false)).toBe("Toggle Dark mode");
    expect(phraseFor({ sel: "#a", role: "searchbox", name: "Search" }, true)).toBe("Type in Search");
    expect(phraseFor({ sel: "#a", role: "searchbox", name: "Search" }, false)).toBe("Click Search");
    expect(phraseFor({ sel: "#a", name: "  Save \n changes " }, false)).toBe("Click Save changes");
  });

  it("names nothing it has no name for, and shortens long names", () => {
    expect(phraseFor({ sel: "#a", role: "button" }, false)).toBeUndefined();
    expect(phraseFor({ sel: "#a", role: "button", name: "   " }, false)).toBeUndefined();
    const long = phraseFor({ sel: "#a", role: "button", name: "x".repeat(80) }, false)!;
    expect(long).toMatch(/^Click x+…$/);
    expect(long.length).toBeLessThanOrEqual(66);
  });
});

describe("caption generator", () => {
  it("gives one caption per burst of activity, from its first named click", () => {
    const captions = generateCaptions([
      down(1000, { role: "button" }), // unnamed: skipped, but part of the burst
      down(1500, { role: "button", name: "New report" }),
      down(2000, { role: "searchbox", name: "Search" }),
      type(2300),
      type(2400),
      down(2400 + CAPTION_GAP_MS + 1, { role: "link", name: "Settings" }),
    ]);
    expect(captions.map((caption) => caption.text)).toEqual(["Click New report", "Open Settings"]);
    expect(captions[0]).toMatchObject({ atMs: 1200, source: "auto" });
    // It lasts until a second after the burst's last activity, and ends before the next caption.
    expect(captions[0]!.durMs).toBe(2400 + 1000 - 1200);
    expect(captions[0]!.atMs + captions[0]!.durMs).toBeLessThan(captions[1]!.atMs);
    expect(captions[1]!.durMs).toBe(1800); // a lone click shows for the minimum time
  });

  it("says Type in when the burst types into the field it clicked", () => {
    expect(generateCaptions([down(1000, { role: "textbox", name: "Email" }), type(1200)])[0]!.text).toBe(
      "Type in Email",
    );
  });

  it("is deterministic, and makes nothing from a log without named clicks", () => {
    const events = [down(500, { role: "button", name: "Go" }), down(5000, { role: "button", name: "Stop" })];
    expect(generateCaptions(events)).toEqual(generateCaptions(events));
    expect(generateCaptions([down(1000), type(1200)])).toEqual([]);
    expect(generateCaptions([])).toEqual([]);
  });

  it("never captions a click inside a redacted box", () => {
    const events: TakeEvent[] = [
      { t: 0, k: "redact", sel: ".secret", rects: [[50, 50, 100, 100]] },
      down(1000, { role: "button", name: "Reveal card" }, 100, 100),
      down(1200, { role: "button", name: "Next" }, 300, 300),
    ];
    const track = redactionTrack(events, [{ sel: ".secret", mode: "blur" }]);
    expect(generateCaptions(events, track).map((caption) => caption.text)).toEqual(["Click Next"]);
    expect(generateCaptions(events).map((caption) => caption.text)).toEqual(["Click Reveal card"]);
  });
});

describe("resolved captions", () => {
  const events = [down(1000, { role: "button", name: "New report" }), down(6000, { role: "link", name: "Settings" })];
  const edit = defaultEdit(10_000);

  it("regenerates automatic captions and keeps manual ones in their place", () => {
    expect(resolveCaptions(edit, events).map((caption) => caption.text)).toEqual(["Click New report", "Open Settings"]);
    const manual: Caption = { atMs: 700, durMs: 1800, text: "Start a report", source: "manual" };
    const stale: Caption = { atMs: 6000, durMs: 500, text: "Old text", source: "auto" };
    const withEdits = { ...edit, captions: { auto: true, items: [manual, stale] } };
    // The manual item replaces the generated caption it overlaps; a stored auto item is regenerated.
    expect(resolveCaptions(withEdits, events).map((caption) => caption.text)).toEqual([
      "Start a report",
      "Open Settings",
    ]);
  });

  it("hides a caption whose text was cleared, except to the editor", () => {
    const cleared = {
      ...edit,
      captions: { auto: true, items: [{ atMs: 700, durMs: 1800, text: "", source: "manual" as const }] },
    };
    expect(resolveCaptions(cleared, events).map((caption) => caption.text)).toEqual(["Open Settings"]);
    expect(resolveCaptions(cleared, events, { keepEmpty: true }).map((caption) => caption.text)).toEqual([
      "",
      "Open Settings",
    ]);
  });

  it("shows only the stored items when automatic captions are off", () => {
    const off = {
      ...edit,
      captions: { auto: false, items: [{ atMs: 0, durMs: 900, text: "Hi", source: "auto" as const }] },
    };
    expect(resolveCaptions(off, events).map((caption) => caption.text)).toEqual(["Hi"]);
    expect(resolveCaptions({ ...edit, captions: { auto: false, items: [] } }, events)).toEqual([]);
  });

  it("skips redacted elements through the edit's redaction", () => {
    // The box is gone before the second click.
    const hidden: TakeEvent[] = [
      { t: 0, k: "redact", sel: ".s", rects: [[0, 0, 200, 200]] },
      { t: 3000, k: "redact", sel: ".s", rects: [] },
      ...events,
    ];
    const redacted = { ...edit, redact: [{ sel: ".s", mode: "blur" as const }] };
    expect(resolveCaptions(redacted, hidden).map((caption) => caption.text)).toEqual(["Open Settings"]);
  });

  it("fades a caption in and out, and lets a later one win", () => {
    const list: Caption[] = [
      { atMs: 1000, durMs: 2000, text: "A", source: "auto" },
      { atMs: 2500, durMs: 1000, text: "B", source: "auto" },
    ];
    expect(captionAt(list, 999)).toBeUndefined();
    expect(captionAt(list, 1000)).toEqual({ text: "A", opacity: 0 });
    expect(captionAt(list, 1500)).toEqual({ text: "A", opacity: 1 });
    expect(captionAt(list, 2600)?.text).toBe("B");
    expect(captionAt(list, 3500)).toBeUndefined();
  });
});

describe("key pills", () => {
  it("come only from combos, labelled like keycaps, and show for a moment", () => {
    const events: TakeEvent[] = [
      type(100),
      { t: 1000, k: "combo", keys: ["Meta", "k"] },
      { t: 1300, k: "combo", keys: ["Control", "Shift", "ArrowUp"] },
    ];
    const pills = keyPills(events);
    expect(pills).toEqual([
      { atMs: 1000, keys: ["⌘", "K"] },
      { atMs: 1300, keys: ["Ctrl", "⇧", "↑"] },
    ]);
    expect(pillsAt(pills, 500)).toEqual([]);
    expect(pillsAt(pills, 1400).map((pill) => pill.keys[0])).toEqual(["⌘", "Ctrl"]);
    expect(pillsAt(pills, 1000 + KEY_PILL_MS).map((pill) => pill.keys[0])).toEqual(["Ctrl"]);
    expect(pillsAt(pills, 1000 + KEY_PILL_MS - 75)[0]!.opacity).toBeCloseTo(0.5);
    expect(keyLabel("Enter")).toBe("↵");
    expect(keyLabel("F5")).toBe("F5");
  });
});
