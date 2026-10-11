import type { Issue, Measurement, Transform } from "../core";

/** Live Surface registration and untransformed layout measurement for one Scene.
 * Entries are keyed by mount identity, not by public id, so duplicate ids still reach
 * validation and a StrictMode cleanup removes only its own binding.
 */
export type Binding = {
  token: symbol;
  id: string;
  parent?: symbol;
  element: HTMLElement; // the spatial wrapper that carries the 3D transform
  content: HTMLElement | null; // optional group paint: always a visual leaf
  children: HTMLElement; // a visual leaf unless nested Surfaces registered under it
  transform?: Partial<Transform>; // overrides from the Surface prop, on top of the recipe node
  transformIssue?: string;
};

// offset* geometry ignores CSS transforms, which is exactly what the spatial maths needs.
function origin(element: HTMLElement) {
  let x = 0,
    y = 0;
  for (let node: HTMLElement | null = element; node; node = node.offsetParent as HTMLElement | null) {
    const parent = node.offsetParent as HTMLElement | null;
    x += node.offsetLeft + (parent?.clientLeft ?? 0);
    y += node.offsetTop + (parent?.clientTop ?? 0);
  }
  for (let node = element.parentElement; node; node = node.parentElement) {
    x -= node.scrollLeft;
    y -= node.scrollTop;
  }
  return { x, y };
}

// A spatial group cannot be filtered without flattening its children, so visible text
// or media sitting directly in a group would silently stay sharp. Detect that instead.
function hasUncoveredContent(root: Element): boolean {
  for (const child of root.childNodes) {
    if (child.nodeType === Node.TEXT_NODE && child.textContent?.trim()) return true;
    if (!(child instanceof Element)) continue;
    if (
      child.hasAttribute("data-flick-id") ||
      child.hasAttribute("data-flick-leaf") ||
      child.matches("script,style,template")
    )
      continue;
    const css = getComputedStyle(child);
    if (css.display === "none" || css.visibility === "hidden") continue;
    if (
      child.matches("img,svg,canvas,video,input,textarea,select") ||
      (css.backgroundImage && css.backgroundImage !== "none")
    )
      return true;
    if (hasUncoveredContent(child)) return true;
  }
  return false;
}

const sameMeasurement = (a: Measurement | undefined, b: Measurement) =>
  !!a && a.width === b.width && a.height === b.height && a.offsetX === b.offsetX && a.offsetY === b.offsetY;

/** Where a surface sits before any transform: its size, and its centre relative to its parent's centre. */
function measureBinding(element: HTMLElement, parent: HTMLElement): Measurement {
  const p = origin(parent),
    e = origin(element);
  const width = element.offsetWidth,
    height = element.offsetHeight;
  return {
    width,
    height,
    offsetX: e.x + width / 2 - p.x - parent.offsetWidth / 2,
    offsetY: e.y + height / 2 - p.y - parent.offsetHeight / 2,
  };
}

/** Groups (surfaces that contain surfaces) holding loose text or media that no filter can reach. */
function findUncovered(bindings: Binding[]): Issue[] {
  const groups = new Set(bindings.map((binding) => binding.parent));
  return bindings
    .filter((binding) => groups.has(binding.token) && hasUncoveredContent(binding.children))
    .map((binding) => ({
      code: "unfiltered-content",
      path: binding.id,
      message: `Surface ${binding.id} contains other Surfaces and loose text or media. Wrap that content in its own Surface, or pass it as the group's content prop, so depth of field can reach it.`,
    }));
}

/** Whether a re-registration changes anything the scene has to react to. */
const sameBinding = (previous: Binding | undefined, next: Binding) =>
  !!previous &&
  previous.id === next.id &&
  previous.parent === next.parent &&
  previous.element === next.element &&
  previous.content === next.content &&
  previous.transformIssue === next.transformIssue &&
  JSON.stringify(previous.transform) === JSON.stringify(next.transform);

/** Listeners, and a way to notify them once for many changes made in the same React commit. */
function createNotifier() {
  const listeners = new Set<() => void>();
  let pending = false;
  const publish = () => {
    pending = false;
    for (const listener of [...listeners]) listener();
  };
  return {
    publish,
    /** Notify before the next paint, however many times this is called until then. */
    schedule() {
      if (pending) return;
      pending = true;
      queueMicrotask(() => pending && publish());
    },
    /** Drop a queued notification: the caller is about to react by itself. */
    cancel() {
      pending = false;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

export function createRegistry() {
  const entries = new Map<symbol, Binding>();
  const measurements = new Map<symbol, Measurement>();
  const notifier = createNotifier();
  let stage: HTMLElement | null = null;
  let resize: ResizeObserver | undefined;
  let mutations: MutationObserver | undefined;
  let coverageDirty = true;
  let coverageIssues: Issue[] = [];
  const structureChanged = () => {
    coverageDirty = true;
    notifier.schedule();
  };

  /** Re-read layout. Returns whether anything changed. */
  const measure = (): boolean => {
    if (!stage) return false;
    let changed = false;
    for (const [token, entry] of entries) {
      const parent = (entry.parent && entries.get(entry.parent)?.element) || stage;
      const next = measureBinding(entry.element, parent);
      if (sameMeasurement(measurements.get(token), next)) continue;
      measurements.set(token, next);
      changed = true;
    }
    if (coverageDirty) {
      coverageDirty = false;
      const next = findUncovered([...entries.values()]);
      if (JSON.stringify(next) !== JSON.stringify(coverageIssues)) {
        coverageIssues = next;
        changed = true;
      }
    }
    return changed;
  };

  return {
    entries,
    measurements,
    get coverageIssues() {
      return coverageIssues;
    },
    isGroup: (token: symbol) => {
      for (const binding of entries.values()) if (binding.parent === token) return true;
      return false;
    },
    subscribe: notifier.subscribe,
    mount(element: HTMLElement) {
      stage = element;
      if (typeof ResizeObserver !== "undefined") {
        resize = new ResizeObserver(() => measure() && notifier.publish());
        resize.observe(element);
        for (const entry of entries.values()) resize.observe(entry.element);
      }
      if (typeof MutationObserver !== "undefined") {
        mutations = new MutationObserver(structureChanged);
        mutations.observe(element, { childList: true, subtree: true, characterData: true });
      }
      return () => {
        resize?.disconnect();
        mutations?.disconnect();
        resize = mutations = undefined;
        stage = null;
      };
    },
    upsert(binding: Binding) {
      const previous = entries.get(binding.token);
      entries.set(binding.token, binding);
      if (previous?.element !== binding.element) {
        if (previous) resize?.unobserve(previous.element);
        resize?.observe(binding.element);
      }
      if (!sameBinding(previous, binding)) structureChanged();
    },
    remove(token: symbol) {
      const entry = entries.get(token);
      if (!entry) return;
      resize?.unobserve(entry.element);
      entries.delete(token);
      measurements.delete(token);
      structureChanged();
    },
    /** Called by Scene after its own commit: measure now and drop any queued notification. */
    refresh() {
      notifier.cancel();
      measure();
    },
  };
}
export type Registry = ReturnType<typeof createRegistry>;
