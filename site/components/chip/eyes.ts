/** How far the glint in Chip's eye may travel from the centre, in artboard units. */
const REACH = 7;

const watched = new Set<SVGSVGElement>();
let pointer: { x: number; y: number } | null = null;
let frame = 0;

function aim() {
  frame = 0;
  if (!pointer) return;
  for (const svg of watched) {
    const eye = svg.querySelector<SVGGraphicsElement>(".chip__eye");
    if (!eye) continue;
    const box = eye.getBoundingClientRect();
    const dx = pointer.x - (box.left + box.width / 2);
    const dy = pointer.y - (box.top + box.height / 2);
    const distance = Math.hypot(dx, dy) || 1;
    const pull = Math.min(1, distance / 160) * REACH;
    const facing = svg.dataset.flip === "1" ? -1 : 1;
    svg.style.setProperty("--look-x", `${((dx / distance) * pull * facing).toFixed(2)}px`);
    svg.style.setProperty("--look-y", `${((dy / distance) * pull).toFixed(2)}px`);
  }
}

function onMove(event: PointerEvent) {
  pointer = { x: event.clientX, y: event.clientY };
  if (!frame) frame = requestAnimationFrame(aim);
}

/** Makes this Chip look at the pointer. Returns the function that stops it. */
export function trackEye(svg: SVGSVGElement) {
  if (watched.size === 0) window.addEventListener("pointermove", onMove, { passive: true });
  watched.add(svg);
  return () => {
    watched.delete(svg);
    if (watched.size === 0) window.removeEventListener("pointermove", onMove);
  };
}
