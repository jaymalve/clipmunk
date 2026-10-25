import { type ElementIdentity, SOURCE_ATTR } from "../core";

/** Which element an interaction touched, in a form that is useful later and safe to keep:
 * a short CSS selector that matches only that element, its role, and for controls its
 * accessible name. Names come from labels and text, never from what a field holds, and an
 * element inside a redaction selector is never named.
 */
export const INTERACTIVE =
  'button, a[href], input, textarea, select, label, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], [role="checkbox"], [role="switch"], [contenteditable]';
const TEST_IDS = ["data-testid", "data-test", "data-cy"];
const MAX_NAME = 80;

type Root = Document | ShadowRoot;
const rootOf = (element: Element): Root => element.getRootNode() as Root;
const cssEscape = (value: string) =>
  typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : value.replace(/[^\w-]/g, (char) => `\\${char}`);
const quote = (value: string) => `"${value.replace(/["\\]/g, (char) => `\\${char}`)}"`;

/** Elements matching (or inside one matching) any of the selectors. Invalid selectors match nothing. */
export function insideRedacted(element: Element, selectors: readonly string[]): boolean {
  return selectors.some((selector) => {
    try {
      return !!element.closest(selector);
    } catch {
      return false;
    }
  });
}

export function identify(element: Element, redact: readonly string[] = []): ElementIdentity {
  const hidden = insideRedacted(element, redact);
  const identity: ElementIdentity = { sel: selectorFor(element, !hidden) };
  const role = roleOf(element);
  if (role) identity.role = role;
  const testId = TEST_IDS.map((name) => element.getAttribute(name)).find(Boolean);
  if (testId && !hidden) identity.testId = testId.slice(0, 120);
  // The file that rendered it, when clipmunk/vite or clipmunk/next marked it in development.
  const src = element.closest(`[${SOURCE_ATTR}]`)?.getAttribute(SOURCE_ATTR);
  if (src) identity.src = src.slice(0, 300);
  if (!hidden && element.matches(INTERACTIVE)) {
    const name = accessibleName(element);
    if (name) identity.name = name;
  }
  return identity;
}

// --- Selector

/** Generated ids (React's useId, numbered ids) change between renders and are useless later. */
const stableId = (id: string) => /^[A-Za-z][\w-]*$/.test(id) && !/\d{4,}/.test(id);
/** Class names a person wrote, not ones a CSS-in-JS tool hashed. */
const stableClass = (name: string) =>
  /^[A-Za-z][\w-]*$/.test(name) &&
  !/^(?:css|sc|jsx|emotion|styled|tw)-/.test(name) &&
  !/[0-9a-f]{5,}|\d{3,}/i.test(name);

/** Selectors that name this element on their own, best first. Attribute values are used only
 * when `values` is true: for an element being redacted they could be the very thing hidden.
 */
function anchors(element: Element, values: boolean): string[] {
  const tag = element.tagName.toLowerCase();
  const out: string[] = [];
  if (element.id && stableId(element.id)) out.push(`#${cssEscape(element.id)}`);
  for (const name of TEST_IDS) {
    const value = element.getAttribute(name);
    if (value && values) out.push(`[${name}=${quote(value)}]`);
  }
  if (values) {
    const label = element.getAttribute("aria-label");
    if (label) out.push(`${tag}[aria-label=${quote(label)}]`);
    const field = element.getAttribute("name");
    if (field && /^(?:input|select|textarea|button)$/.test(tag)) out.push(`${tag}[name=${quote(field)}]`);
  }
  return out;
}

function step(element: Element, numbered: boolean): string {
  const tag = element.tagName.toLowerCase();
  const classes = [...element.classList].filter(stableClass).slice(0, 2);
  let part = tag + classes.map((name) => `.${cssEscape(name)}`).join("");
  const parent = element.parentElement;
  if (parent && (numbered || !classes.length)) {
    const same = [...parent.children].filter((child) => child.tagName === element.tagName);
    if (same.length > 1) part += `:nth-of-type(${same.indexOf(element) + 1})`;
  }
  return part;
}

export function selectorFor(element: Element, values = true): string {
  const root = rootOf(element);
  const matches = (selector: string) => {
    try {
      return [...root.querySelectorAll(selector)];
    } catch {
      return [];
    }
  };
  const unique = (selector: string) => {
    const found = matches(selector);
    return found.length === 1 && found[0] === element;
  };
  for (const anchor of anchors(element, values)) if (unique(anchor)) return anchor;
  // Walk up, stopping at the first ancestor that names itself; number the steps if that is
  // not enough on its own.
  for (const numbered of [false, true]) {
    const parts: string[] = [];
    for (let node: Element | null = element; node?.parentElement; node = node.parentElement) {
      const anchor =
        node !== element ? anchors(node, values).find((candidate) => matches(candidate).length === 1) : undefined;
      parts.unshift(anchor ?? step(node, numbered));
      const selector = parts.join(" > ");
      if (unique(selector)) return selector;
      if (anchor) break;
    }
  }
  // Fully numbered from the top; unique by construction.
  const parts: string[] = [];
  for (let node: Element | null = element; node?.parentElement; node = node.parentElement) {
    const tag = node.tagName;
    const index = [...node.parentElement.children].filter((child) => child.tagName === tag).indexOf(node);
    parts.unshift(`${tag.toLowerCase()}:nth-of-type(${index + 1})`);
  }
  return parts.join(" > ") || element.tagName.toLowerCase();
}

// --- Role

const INPUT_ROLES: Record<string, string> = {
  button: "button",
  submit: "button",
  reset: "button",
  image: "button",
  checkbox: "checkbox",
  radio: "radio",
  range: "slider",
  search: "searchbox",
};
export function roleOf(element: Element): string | undefined {
  const explicit = element.getAttribute("role")?.trim().split(/\s+/)[0];
  if (explicit) return explicit;
  const tag = element.tagName.toLowerCase();
  if (tag === "button" || tag === "summary") return "button";
  if (tag === "a" && element.hasAttribute("href")) return "link";
  if (tag === "select") return "combobox";
  if (tag === "textarea") return "textbox";
  if (tag === "input") return INPUT_ROLES[(element as HTMLInputElement).type] ?? "textbox";
  if (element.hasAttribute("contenteditable")) return "textbox";
  return undefined;
}

// --- Accessible name

const FIELD = /^(?:input|select|textarea)$/;
const collapse = (text: string) => text.replace(/\s+/g, " ").trim();
const clip = (text: string) => (text.length > MAX_NAME ? `${text.slice(0, MAX_NAME - 1)}…` : text);

/** Visible text of a subtree, without the contents of form fields and hidden parts. */
function textOf(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (!(node instanceof Element)) return "";
  if (node.getAttribute("aria-hidden") === "true" || node.hasAttribute("hidden")) return "";
  const tag = node.tagName.toLowerCase();
  if (FIELD.test(tag) || tag === "script" || tag === "style" || tag === "template") return "";
  if (tag === "img") return ` ${node.getAttribute("alt") ?? ""} `;
  if (tag === "svg") return ` ${node.querySelector("title")?.textContent ?? ""} `;
  const label = node.getAttribute("aria-label");
  if (label && node !== node.ownerDocument.documentElement) return ` ${label} `;
  return [...node.childNodes].map(textOf).join("");
}

export function accessibleName(element: Element): string | undefined {
  const document = element.ownerDocument;
  const ids = element.getAttribute("aria-labelledby");
  if (ids) {
    const text = collapse(
      ids
        .split(/\s+/)
        .map((id) => document.getElementById(id))
        .map((label) => (label ? textOf(label) : ""))
        .join(" "),
    );
    if (text) return clip(text);
  }
  const label = collapse(element.getAttribute("aria-label") ?? "");
  if (label) return clip(label);
  const tag = element.tagName.toLowerCase();
  if (FIELD.test(tag)) {
    const input = element as HTMLInputElement;
    // A button-like input shows its value as its label; any other field's value is what the user typed.
    if (tag === "input" && ["submit", "button", "reset"].includes(input.type))
      return clip(collapse(input.value)) || undefined;
    if (tag === "input" && input.type === "image") return clip(collapse(input.alt)) || undefined;
    const labels = [...(input.labels ?? [])].map(textOf).join(" ");
    const text =
      collapse(labels) ||
      collapse(element.getAttribute("placeholder") ?? "") ||
      collapse(element.getAttribute("title") ?? "");
    return text ? clip(text) : undefined;
  }
  const text = collapse(textOf(element)) || collapse(element.getAttribute("title") ?? "");
  return text ? clip(text) : undefined;
}

// --- Keys

const MODIFIERS = new Set(["Control", "Alt", "Shift", "Meta", "AltGraph", "CapsLock", "Fn", "OS"]);
/** The keys of a combination, modifiers first (Control, Alt, Shift, Meta), or undefined when
 * this is not one: no modifier other than Shift is held, or the key is itself a modifier.
 */
export function comboOf(event: KeyboardEvent): string[] | undefined {
  if (!event.ctrlKey && !event.metaKey && !event.altKey) return undefined;
  if (MODIFIERS.has(event.key)) return undefined;
  // The physical key, so Alt+K reads as K and not as the character Alt produces.
  const key =
    /^Key([A-Z])$/.exec(event.code)?.[1] ??
    /^Digit(\d)$/.exec(event.code)?.[1] ??
    (event.key.length === 1 ? event.key.toUpperCase() : event.key);
  const keys: string[] = [];
  if (event.ctrlKey) keys.push("Control");
  if (event.altKey) keys.push("Alt");
  if (event.shiftKey) keys.push("Shift");
  if (event.metaKey) keys.push("Meta");
  keys.push(key.slice(0, 20));
  return keys;
}
