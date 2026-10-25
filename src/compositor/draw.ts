import type { VideoSample } from "mediabunny";
import type { CursorState, CursorStyle, KeyPill, RedactBox, Take, ZoomView } from "../core";

/** Draws one frame of a take. A pure function of its arguments: the same inputs always
 * produce the same pixels, which is what makes the preview and the export identical.
 *
 * Layers, bottom to top: canvas background; the screen recording in a rounded, shadowed
 * frame, moved by the zoom; the redacted areas, blurred or blocked on the recording so they
 * move and zoom with it; click ripples and the synthetic cursor, which zoom with the
 * content; the camera bubble, which does not; then the caption and key pills over the bottom of
 * the recording, in canvas space so they stay readable at any zoom.
 */
export type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
export type TakeFrame = {
  screen: VideoSample | null;
  cam: VideoSample | null;
  view: ZoomView;
  cursor: CursorState & { opacity: number };
  /** Recent clicks with their age in milliseconds. */
  clicks: { x: number; y: number; ageMs: number }[];
  /** Areas to hide, in source CSS pixels. */
  redact: RedactBox[];
  caption?: { text: string; opacity: number };
  /** With reframing, the part of the recording in view: its left edge and width in source CSS pixels. */
  crop?: { x: number; width: number };
  keys: (KeyPill & { opacity: number })[];
};

/** The solid colour of a blocked area. */
export const REDACT_BLOCK = "#1c1c21";

const RIPPLE_MS = 520;
// Cursor glyphs on a 22-unit grid, with the point that sits on the pointer position.
const GLYPHS: Record<CursorStyle, { path: string; hotspot: [number, number] }> = {
  default: { path: "M4 2.5v15.2l4.1-3.6 2.6 5.9 2.5-1.1-2.6-5.8 5.4-.4z", hotspot: [4, 2.5] },
  pointer: {
    path: "M8 1.5c-1 0-1.8.8-1.8 1.8v8.1l-1.3-1.2c-.8-.7-2-.6-2.6.2-.6.7-.5 1.8.1 2.5l4.3 4.9c.9 1 2.2 1.6 3.6 1.6h3.3c2.6 0 4.7-2.1 4.7-4.7v-4.6c0-.9-.7-1.6-1.6-1.6-.4 0-.8.1-1 .4-.2-.8-.9-1.3-1.7-1.3-.5 0-.9.2-1.2.5-.3-.7-.9-1.1-1.7-1.1-.3 0-.6.1-.9.2V3.3c0-1-.8-1.8-1.8-1.8z",
    hotspot: [8, 1.5],
  },
  text: {
    path: "M7 2h3.2c.5 0 .8.2.8.2s.3-.2.8-.2H15v1.6h-2.6c-.4 0-.6.2-.6.6v13.6c0 .4.2.6.6.6H15V20h-3.2c-.5 0-.8-.2-.8-.2s-.3.2-.8.2H7v-1.6h2.6c.4 0 .6-.2.6-.6V4.2c0-.4-.2-.6-.6-.6H7z",
    hotspot: [11, 11],
  },
};
const paths = new Map<string, Path2D>();
const glyph = (style: CursorStyle) => {
  const { path, hotspot } = GLYPHS[style];
  if (!paths.has(path)) paths.set(path, new Path2D(path));
  return { path: paths.get(path)!, hotspot };
};

/** Where the recording sits on the canvas, and the factor from source CSS pixels to canvas pixels.
 * `visible` is the part of the recording that is laid out: all of it, or a reframing crop.
 */
export function layoutTake(
  width: number,
  height: number,
  take: Take,
  visible: { width: number; height: number } = take.source,
) {
  const { canvas } = take.edit,
    source = visible;
  // Pixel-valued settings are authored against the edit's canvas; scale them for other output sizes.
  const unit = Math.min(width / canvas.width, height / canvas.height);
  const pad = canvas.padding * Math.min(width, height);
  const scale = Math.min((width - 2 * pad) / source.width, (height - 2 * pad) / source.height);
  const boxWidth = source.width * scale,
    boxHeight = source.height * scale;
  return {
    unit,
    pad,
    scale,
    box: { x: (width - boxWidth) / 2, y: (height - boxHeight) / 2, width: boxWidth, height: boxHeight },
    radius: canvas.radius * unit,
  };
}

export function drawTake(ctx: Context2D, width: number, height: number, take: Take, frame: TakeFrame): void {
  const { edit, source } = take;
  const { unit, pad, scale, box, radius } = layoutTake(
    width,
    height,
    take,
    frame.crop ? { width: frame.crop.width, height: source.height } : source,
  );
  const zoom = frame.view.scale;
  const centerX = box.x + box.width / 2,
    centerY = box.y + box.height / 2;
  /** Source CSS pixels to canvas pixels, through the zoom. */
  const place = (x: number, y: number) =>
    [centerX + (x - frame.view.x) * scale * zoom, centerY + (y - frame.view.y) * scale * zoom] as const;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = edit.canvas.background;
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  const frameShape = () => {
    ctx.beginPath();
    ctx.roundRect(box.x, box.y, box.width, box.height, radius);
  };
  if (edit.canvas.shadow > 0 && pad > 0) {
    ctx.save();
    ctx.shadowColor = `rgba(0, 0, 0, ${0.6 * edit.canvas.shadow})`;
    ctx.shadowBlur = 70 * unit * edit.canvas.shadow;
    ctx.shadowOffsetY = 24 * unit * edit.canvas.shadow;
    frameShape();
    ctx.fillStyle = source.background;
    ctx.fill();
    ctx.restore();
  }

  ctx.save();
  frameShape();
  ctx.clip();
  ctx.fillStyle = source.background;
  ctx.fillRect(box.x, box.y, box.width, box.height);
  if (frame.screen) {
    const [x, y] = place(0, 0);
    frame.screen.draw(ctx, x, y, source.width * scale * zoom, source.height * scale * zoom);
  }
  for (const { rect, mode } of frame.redact) {
    const [x, y] = place(rect[0], rect[1]);
    const w = rect[2] * scale * zoom,
      h = rect[3] * scale * zoom;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    if (mode === "block" || !frame.screen) {
      ctx.fillStyle = REDACT_BLOCK;
      ctx.fillRect(x, y, w, h);
    } else {
      // Strong enough that text of any size in the box is unreadable. Only the part of the
      // recording the blur reaches is drawn, which keeps a full-frame blur off every frame.
      const radius = Math.max(6 * scale * zoom, Math.min(w, h) / 4);
      const reach = (3 * radius) / (scale * zoom);
      const left = Math.max(0, rect[0] - reach),
        top = Math.max(0, rect[1] - reach);
      const right = Math.min(source.width, rect[0] + rect[2] + reach),
        bottom = Math.min(source.height, rect[1] + rect[3] + reach);
      const pixels = frame.screen.displayWidth / source.width;
      const [dx, dy] = place(left, top);
      ctx.fillStyle = source.background;
      ctx.fillRect(x, y, w, h);
      if (right > left && bottom > top) {
        ctx.filter = `blur(${radius}px)`;
        frame.screen.draw(
          ctx,
          left * pixels,
          top * pixels,
          (right - left) * pixels,
          (bottom - top) * pixels,
          dx,
          dy,
          (right - left) * scale * zoom,
          (bottom - top) * scale * zoom,
        );
      }
    }
    ctx.restore();
  }
  if (edit.cursor.visible) {
    const size = edit.cursor.size * unit * zoom;
    if (edit.cursor.clickEffect === "ripple")
      for (const click of frame.clicks) {
        if (click.ageMs < 0 || click.ageMs > RIPPLE_MS) continue;
        const progress = click.ageMs / RIPPLE_MS;
        const [x, y] = place(click.x, click.y);
        ctx.beginPath();
        ctx.arc(x, y, (8 + 26 * (1 - (1 - progress) ** 3)) * size, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 255, 255, ${0.32 * (1 - progress)})`;
        ctx.fill();
        ctx.lineWidth = 1.5 * size;
        ctx.strokeStyle = `rgba(0, 0, 0, ${0.3 * (1 - progress)})`;
        ctx.stroke();
      }
    if (frame.cursor.visible && frame.cursor.opacity > 0) {
      const { path, hotspot } = glyph(frame.cursor.style);
      const [x, y] = place(frame.cursor.x, frame.cursor.y);
      const press = frame.cursor.pressed ? 0.88 : 1;
      ctx.save();
      ctx.globalAlpha = frame.cursor.opacity;
      ctx.translate(x, y);
      ctx.scale(size * press, size * press);
      ctx.translate(-hotspot[0], -hotspot[1]);
      ctx.shadowColor = "rgba(0, 0, 0, 0.35)";
      ctx.shadowBlur = 4 * size;
      ctx.shadowOffsetY = 1.5 * size;
      ctx.fillStyle = "#ffffff";
      ctx.fill(path);
      ctx.shadowColor = "transparent";
      ctx.lineJoin = "round";
      ctx.lineWidth = 1.3;
      ctx.strokeStyle = "#111111";
      ctx.stroke(path);
      ctx.restore();
    }
  }
  ctx.restore();

  if (frame.cam && source.cam && edit.cam.visible) {
    const diameter = edit.cam.size * Math.min(width, height);
    const margin = Math.max(pad * 0.55, 28 * unit);
    const left = edit.cam.corner.endsWith("l") ? margin : width - margin - diameter;
    const top = edit.cam.corner.startsWith("t") ? margin : height - margin - diameter;
    const shape = () => {
      ctx.beginPath();
      if (edit.cam.shape === "circle") ctx.arc(left + diameter / 2, top + diameter / 2, diameter / 2, 0, Math.PI * 2);
      else ctx.roundRect(left, top, diameter, diameter, diameter * 0.16);
    };
    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.45)";
    ctx.shadowBlur = 30 * unit;
    ctx.shadowOffsetY = 10 * unit;
    shape();
    ctx.fillStyle = "#000000";
    ctx.fill();
    ctx.restore();
    ctx.save();
    shape();
    ctx.clip();
    // Cover the square with the camera picture, centred, and flip it like a mirror if asked.
    const cover = diameter / Math.min(source.cam.width, source.cam.height);
    const drawWidth = source.cam.width * cover,
      drawHeight = source.cam.height * cover;
    ctx.translate(left + diameter / 2, top + diameter / 2);
    if (edit.cam.mirror) ctx.scale(-1, 1);
    frame.cam.draw(ctx, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
    ctx.restore();
    ctx.save();
    shape();
    ctx.lineWidth = 3 * unit;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
    ctx.stroke();
    ctx.restore();
  }
  drawOverlays(ctx, take, frame, box, unit);
  ctx.restore();
}

type Box = { x: number; y: number; width: number; height: number };

/** The caption strip and key pills, along the bottom of the recording. Their colour is the
 * edit's backdrop, which the brand sets, with text in black or white, whichever reads better.
 */
function drawOverlays(ctx: Context2D, take: Take, frame: TakeFrame, box: Box, unit: number) {
  const pills = take.edit.keys.visible ? frame.keys : [];
  if (!frame.caption && !pills.length) return;
  ctx.fillStyle = take.edit.canvas.background;
  const [r, g, b] = rgbOf(String(ctx.fillStyle));
  const fill = `rgba(${r}, ${g}, ${b}, 0.88)`;
  const ink = 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#111111" : "#ffffff";
  const margin = 28 * unit;
  let bottom = box.y + box.height - margin;
  const maxWidth = box.width - 2 * margin;
  const centre = box.x + box.width / 2;

  const pill = (text: string, size: number, opacity: number, weight: number, x?: number) => {
    ctx.font = `${weight} ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    let width = ctx.measureText(text).width;
    // Shrink long text to fit the recording's width.
    if (width + size * 1.6 > maxWidth) {
      size *= (maxWidth - size * 1.6) / width;
      ctx.font = `${weight} ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
      width = ctx.measureText(text).width;
    }
    const w = width + size * 1.6,
      h = size * 1.9;
    const left = x ?? centre - w / 2;
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.shadowColor = "rgba(0, 0, 0, 0.3)";
    ctx.shadowBlur = 18 * unit;
    ctx.shadowOffsetY = 4 * unit;
    ctx.beginPath();
    ctx.roundRect(left, bottom - h, w, h, Math.min(h / 2, 14 * unit));
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.fillStyle = ink;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, left + w / 2, bottom - h / 2 + size * 0.05);
    ctx.restore();
    return { w, h };
  };

  if (frame.caption) {
    const { h } = pill(frame.caption.text, 34 * unit, frame.caption.opacity, 600);
    bottom -= h + 14 * unit;
  }
  if (pills.length) {
    // Measure first so the row is centred, then draw left to right.
    const size = 30 * unit,
      gap = 12 * unit;
    ctx.font = `700 ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    const texts = pills.map((item) => item.keys.join(" "));
    const widths = texts.map((text) => ctx.measureText(text).width + size * 1.6);
    let x = centre - (widths.reduce((sum, width) => sum + width, 0) + gap * (pills.length - 1)) / 2;
    pills.forEach((item, index) => {
      pill(texts[index]!, size, item.opacity, 700, x);
      x += widths[index]! + gap;
    });
  }
}

/** [r, g, b] of a colour as the canvas normalises it: "#rrggbb" or "rgba(r, g, b, a)". */
function rgbOf(colour: string): [number, number, number] {
  if (colour.startsWith("#") && colour.length === 7)
    return [1, 3, 5].map((index) => Number.parseInt(colour.slice(index, index + 2), 16)) as [number, number, number];
  const parts = colour.match(/[\d.]+/g)?.map(Number) ?? [];
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}
