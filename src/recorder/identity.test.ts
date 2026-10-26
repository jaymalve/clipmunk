// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { accessibleName, comboOf, identify, roleOf, selectorFor } from "./identity";

const page = (html: string) => {
  document.body.innerHTML = html;
};
const $ = (selector: string) => document.querySelector(selector)!;
const unique = (selector: string, element: Element) => {
  const found = document.querySelectorAll(selector);
  return found.length === 1 && found[0] === element;
};

beforeEach(() => page(""));

describe("selectors", () => {
  it("prefer an id, a test id, a label or a field name, when it is unique", () => {
    page(`
      <button id="save">Save</button>
      <button data-testid="new-invoice">New invoice</button>
      <button aria-label="Close dialog">×</button>
      <input name="client">
      <button id=":r3:">Generated</button>`);
    expect(selectorFor($("#save"))).toBe("#save");
    expect(selectorFor($("[data-testid]"))).toBe('[data-testid="new-invoice"]');
    expect(selectorFor($("[aria-label]"))).toBe('button[aria-label="Close dialog"]');
    expect(selectorFor($("input"))).toBe('input[name="client"]');
    // React's generated ids change between renders, so they are not used.
    const generated = document.querySelectorAll("button")[3]!;
    expect(selectorFor(generated)).not.toContain(":r3:");
    expect(unique(selectorFor(generated), generated)).toBe(true);
  });

  it("walk up to a named ancestor, and number siblings only when needed", () => {
    page(`
      <main id="invoices">
        <table><tbody>
          <tr><td>Northwind</td><td><button class="btn send">Send</button></td></tr>
          <tr><td>Globex</td><td><button class="btn send">Send</button></td></tr>
        </tbody></table>
      </main>
      <div class="css-1x2y3z4 panel"><span>Hi</span></div>`);
    // The shortest path that is unique, so no ancestor is needed here.
    expect(selectorFor(document.querySelectorAll("button")[1]!)).toBe(
      "tr:nth-of-type(2) > td:nth-of-type(2) > button.btn.send",
    );
    // Hashed CSS-in-JS classes are left out.
    expect(selectorFor($(".panel"))).toBe("div.panel");
    for (const element of document.querySelectorAll("*"))
      if (element !== document.documentElement)
        expect(unique(selectorFor(element), element), element.outerHTML).toBe(true);
  });

  it("stop at an ancestor that names itself", () => {
    page(
      `<section id="billing"><button class="pay">Pay</button></section><section><button class="pay">Pay</button></section>`,
    );
    expect(selectorFor($("#billing button"))).toBe("#billing > button.pay");
  });

  it("use no attribute values for an element being redacted", () => {
    page(`<p><span class="client-email" aria-label="jane@acme.com" data-testid="email-jane">jane@acme.com</span></p>`);
    const email = $(".client-email");
    const identity = identify(email, [".client-email"]);
    expect(identity.sel).toBe("span.client-email");
    expect(JSON.stringify(identity)).not.toContain("jane");
  });
});

describe("names and roles", () => {
  it("name controls by their label, never by what a field holds", () => {
    page(`
      <label for="client">Client</label><input id="client" value="Northwind Co">
      <label>Amount <input id="amount" value="4200"></label>
      <input id="search" type="search" placeholder="Search invoices" value="overdue">
      <input id="send" type="submit" value="Send invoice">
      <textarea id="notes" aria-label="Notes">private notes</textarea>
      <select id="plan"><option>Monthly</option><option selected>Yearly</option></select>`);
    expect(accessibleName($("#client"))).toBe("Client");
    expect(accessibleName($("#amount"))).toBe("Amount");
    expect(accessibleName($("#search"))).toBe("Search invoices");
    expect(accessibleName($("#send"))).toBe("Send invoice");
    expect(accessibleName($("#notes"))).toBe("Notes");
    expect(accessibleName($("#plan"))).toBeUndefined();
    expect([roleOf($("#client")), roleOf($("#search")), roleOf($("#send")), roleOf($("#plan"))]).toEqual([
      "textbox",
      "searchbox",
      "button",
      "combobox",
    ]);
  });

  it("name buttons and links by their visible text, labels and image alts", () => {
    page(`
      <button id="a">  + New
         invoice </button>
      <a id="b" href="/x"><img alt="Settings"></a>
      <button id="c"><svg><title>Delete</title></svg></button>
      <button id="d" aria-labelledby="t1 t2">x</button><span id="t1">Send</span><span id="t2">reminder</span>
      <button id="e"><span aria-hidden="true">★</span> Star</button>
      <div id="f" role="tab">${"Overview ".repeat(20)}</div>`);
    expect(accessibleName($("#a"))).toBe("+ New invoice");
    expect(accessibleName($("#b"))).toBe("Settings");
    expect(accessibleName($("#c"))).toBe("Delete");
    expect(accessibleName($("#d"))).toBe("Send reminder");
    expect(accessibleName($("#e"))).toBe("Star");
    expect(accessibleName($("#f"))).toHaveLength(80);
    expect(roleOf($("#b"))).toBe("link");
    expect(roleOf($("#f"))).toBe("tab");
  });

  it("name only controls, and nothing inside a redaction selector", () => {
    page(`
      <table><tr><td id="cell">Juniper &amp; Co $11,950</td></tr></table>
      <div class="secret"><button id="reveal">Show card 4242</button></div>
      <button id="ok" data-testid="ok">OK</button>`);
    expect(identify($("#cell")).name).toBeUndefined();
    const hidden = identify($("#reveal"), [".secret"]);
    expect(hidden.name).toBeUndefined();
    expect(JSON.stringify(hidden)).not.toContain("4242");
    expect(identify($("#ok"), [".secret"])).toEqual({ sel: "#ok", role: "button", name: "OK", testId: "ok" });
    // A selector the page cannot parse hides nothing and breaks nothing.
    expect(identify($("#ok"), ["[broken"]).name).toBe("OK");
  });
});

describe("sources", () => {
  it("name the file that rendered an element, from the nearest mark", () => {
    page(`<div data-clipmunk-src="src/Card.tsx"><span><button id="go">Go</button></span></div><p id="bare">x</p>`);
    expect(identify($("#go"))).toMatchObject({ sel: "#go", src: "src/Card.tsx" });
    expect(identify($("#bare")).src).toBeUndefined();
  });
});

describe("key combinations", () => {
  const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);
  it("are a modifier other than Shift plus a key, read from the physical key", () => {
    expect(comboOf(key({ key: "k", code: "KeyK", metaKey: true }))).toEqual(["Meta", "K"]);
    expect(comboOf(key({ key: "˚", code: "KeyK", altKey: true }))).toEqual(["Alt", "K"]);
    expect(comboOf(key({ key: "Enter", code: "Enter", ctrlKey: true, shiftKey: true }))).toEqual([
      "Control",
      "Shift",
      "Enter",
    ]);
    expect(comboOf(key({ key: "K", code: "KeyK", shiftKey: true }))).toBeUndefined();
    expect(comboOf(key({ key: "a", code: "KeyA" }))).toBeUndefined();
    expect(comboOf(key({ key: "Meta", code: "MetaLeft", metaKey: true }))).toBeUndefined();
  });
});
