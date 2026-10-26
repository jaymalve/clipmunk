import { describe, expect, it } from "vitest";
import { tagSources } from "./source";

describe("tagSources", () => {
  it("tags host elements in compiled JSX, from each compiler's output", () => {
    const babel = `return /* @__PURE__ */ _jsxDEV("div", { className: "card", children: [_jsxDEV(Title, {}, void 0, false), _jsxDEV("button", {
      onClick: go,
      children: "Go"
    }, void 0, false)] }, void 0, true);`;
    const tagged = tagSources(babel, "src/Card.tsx")!;
    expect(tagged).toContain(`_jsxDEV("div", {"data-clipmunk-src": "src/Card.tsx", className: "card"`);
    expect(tagged).toContain(`_jsxDEV("button", {"data-clipmunk-src": "src/Card.tsx",\n      onClick`);
    // A component is not a host element.
    expect(tagged).toContain("_jsxDEV(Title, {}");
    expect(tagSources(`jsx("span", { ...props })`, "a.tsx")).toBe(
      `jsx("span", {"data-clipmunk-src": "a.tsx", ...props })`,
    );
    expect(tagSources(`React.createElement("p", null, "hi")`, "b.jsx")).toBe(
      `React.createElement("p", { "data-clipmunk-src": "b.jsx" }, "hi")`,
    );
    expect(tagSources(`jsxs('svg-icon', {})`, "c.tsx")).toBe(`jsxs('svg-icon', {"data-clipmunk-src": "c.tsx",})`);
  });

  it("leaves modules without host elements alone", () => {
    expect(tagSources("export const x = 1;", "x.ts")).toBeUndefined();
    expect(tagSources(`jsxDEV(Card, { a: 1 })`, "y.tsx")).toBeUndefined();
  });
});
