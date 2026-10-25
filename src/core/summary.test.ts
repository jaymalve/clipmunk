import { describe, expect, it } from "vitest";
import { summarizeEvents, type TakeEvent } from "./index";

describe("event summary", () => {
  it("reads as pages, clicks, typing and shortcuts, without moves or typed text", () => {
    const events: TakeEvent[] = [
      { t: 0, k: "route", path: "/reports" },
      { t: 300, k: "move", x: 1, y: 1 },
      {
        t: 1000,
        k: "down",
        x: 10,
        y: 10,
        button: 0,
        rect: [0, 0, 20, 20],
        el: { sel: "#new", role: "button", name: "New report" },
      },
      {
        t: 1500,
        k: "focus",
        rect: [0, 0, 100, 20],
        editable: true,
        el: { sel: "#q", role: "searchbox", name: "Search" },
      },
      { t: 1600, k: "type", rect: [0, 0, 100, 20] },
      { t: 1800, k: "type", rect: [0, 0, 100, 20] },
      { t: 2400, k: "combo", keys: ["Meta", "k"] },
      { t: 3000, k: "down", x: 50, y: 60, button: 0, rect: [0, 0, 640, 360] },
    ];
    expect(summarizeEvents(events)).toEqual([
      "0.00s page /reports",
      '1.00s click button "New report" (#new)',
      '1.60s typed 2 keys in searchbox "Search" over 0.20s',
      "2.40s shortcut Meta+k",
      "3.00s click at 50,60",
    ]);
  });
});
