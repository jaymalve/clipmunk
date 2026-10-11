import type { FocusMask } from "../core";

/** Depth-varying blur as one SVG filter per visual leaf, maintained imperatively.
 * Two tiny alpha ramps (one per axis) are blended into a linear depth texture; one
 * transfer table per band turns depth into that band's weight; the weighted Gaussian
 * passes are summed. Nothing is cloned and no image is rebuilt per frame.
 */
const SVG_NS = "http://www.w3.org/2000/svg";
let ramps: { x: string; y: string } | undefined;
let nextId = 0;

function depthRamps() {
  if (ramps) return ramps;
  const make = (width: number, height: number) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d")!;
    const image = context.createImageData(width, height);
    for (let i = 0; i < 256; i++) image.data[i * 4 + 3] = i;
    context.putImageData(image, 0, 0);
    return canvas.toDataURL("image/png");
  };
  ramps = { x: make(256, 1), y: make(1, 256) };
  return ramps;
}

const n = (value: number) => +value.toFixed(3);

function markup(mask: FocusMask, width: number, height: number): string {
  const { pad } = mask;
  const box = `x="${n(-pad)}" y="${n(-pad)}" width="${n(width + 2 * pad)}" height="${n(height + 2 * pad)}"`;
  const { x, y } = depthRamps();
  let out =
    `<feImage href="${x}" ${box} preserveAspectRatio="none" result="ax"/>` +
    `<feComponentTransfer in="ax" result="dx"><feFuncA type="table" tableValues="${mask.reverseX ? "1 0" : "0 1"}"/></feComponentTransfer>` +
    `<feImage href="${y}" ${box} preserveAspectRatio="none" result="ay"/>` +
    `<feComponentTransfer in="ay" result="dy"><feFuncA type="table" tableValues="${mask.reverseY ? "1 0" : "0 1"}"/></feComponentTransfer>` +
    `<feComposite in="dx" in2="dy" operator="arithmetic" k1="0" k2="${n(mask.xWeight)}" k3="${n(mask.yWeight)}" k4="0" result="depth"/>`;
  mask.bands.forEach((band, i) => {
    const source = band.stdDeviation > 0 ? `b${i}` : "SourceGraphic";
    if (band.stdDeviation > 0)
      out += `<feGaussianBlur in="SourceGraphic" stdDeviation="${n(band.stdDeviation)}" result="b${i}"/>`;
    out +=
      `<feComponentTransfer in="depth" result="m${i}"><feFuncA type="table" tableValues="${band.weights.map(n).join(" ")}"/></feComponentTransfer>` +
      `<feComposite in="${source}" in2="m${i}" operator="in" result="p${i}"/>`;
    if (i > 0)
      out += `<feComposite in="${i === 1 ? "p0" : `s${i - 1}`}" in2="p${i}" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" result="s${i}"/>`;
  });
  return out;
}

/** Owns the <filter> elements of one Scene. `use` returns the id to reference from CSS. */
export function createFocusFilters(defs: () => SVGDefsElement | null) {
  const filters = new Map<symbol, { element: SVGFilterElement; id: string; signature: string }>();
  return {
    use(token: symbol, mask: FocusMask, width: number, height: number): string | undefined {
      const container = defs();
      if (!container) return undefined;
      let entry = filters.get(token);
      if (!entry) {
        const element = document.createElementNS(SVG_NS, "filter");
        const id = `flick-focus-${nextId++}`;
        element.setAttribute("id", id);
        element.setAttribute("filterUnits", "userSpaceOnUse");
        element.setAttribute("primitiveUnits", "userSpaceOnUse");
        element.setAttribute("color-interpolation-filters", "sRGB");
        container.append(element);
        entry = { element, id, signature: "" };
        filters.set(token, entry);
      }
      const inner = markup(mask, width, height);
      if (inner !== entry.signature) {
        entry.signature = inner;
        entry.element.setAttribute("x", String(n(-mask.pad)));
        entry.element.setAttribute("y", String(n(-mask.pad)));
        entry.element.setAttribute("width", String(n(width + 2 * mask.pad)));
        entry.element.setAttribute("height", String(n(height + 2 * mask.pad)));
        entry.element.innerHTML = inner;
      }
      return entry.id;
    },
    /** Drop filters whose surface no longer needs one. */
    keepOnly(tokens: ReadonlySet<symbol>) {
      for (const [token, entry] of filters) {
        if (tokens.has(token)) continue;
        entry.element.remove();
        filters.delete(token);
      }
    },
  };
}
