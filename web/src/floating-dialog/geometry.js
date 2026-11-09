// Pure position and size maths for FloatingDialog (no React, no DOM), so the parent repo's node --test can check it.
// Ported from AI-DEMO2's useDraggablePanel (clampPosToViewport and the 8-direction resize), without the app-zoom step:
// standalone apps do not zoom the page.

export const MARGIN = 8;
export const KEY_STEP = 10;
export const KEY_STEP_BIG = 50;

// Keep a panel of `size` fully inside a `vp` viewport (with a margin). Used when restoring a saved position and after a
// keyboard move; live pointer dragging is left unclamped on purpose (a second monitor). A panel bigger than the
// viewport is pinned to the top-left margin rather than hidden.
export function clampToViewport(p, size, vp) {
  if (!vp || !vp.w || !vp.h) return p;
  const w = Math.min(size?.w || 0, Math.max(0, vp.w - 2 * MARGIN));
  const h = size?.h || 0;
  const maxX = Math.max(MARGIN, vp.w - w - MARGIN);
  const maxY = Math.max(MARGIN, vp.h - h - MARGIN);
  return { x: Math.min(Math.max(p.x, MARGIN), maxX), y: Math.min(Math.max(p.y, MARGIN), maxY) };
}

// A restored or keyboard-resized size: finite numbers only, at least the minimum, at most the viewport (minus the
// margins). h null means "fit the content" and stays null. Returns null when the size is not usable at all.
export function clampSize(size, min, vp) {
  if (!size || !Number.isFinite(size.w)) return null;
  if (size.h != null && !Number.isFinite(size.h)) return null;
  const maxW = vp && vp.w ? Math.max(min.w, vp.w - 2 * MARGIN) : Infinity;
  const maxH = vp && vp.h ? Math.max(min.h, vp.h - 2 * MARGIN) : Infinity;
  return { w: Math.min(Math.max(size.w, min.w), maxW), h: size.h == null ? null : Math.min(Math.max(size.h, min.h), maxH) };
}

// Resize from any edge or corner. `start` is { x, y, w, h } when the resize began, dx/dy the pointer travel.
// Growing from the north or west edge moves the top-left corner; that growth is capped so the title bar (the only
// drag target) can never be pushed off the top or left edge. The floor is min(0, start) so a panel the user dragged
// off-screen on purpose is not yanked back by resizing it.
export function resizeRect(start, dir, dx, dy, min) {
  let { x, y, w, h } = start;
  if (dir.includes("e")) w = Math.max(min.w, start.w + dx);
  if (dir.includes("w")) {
    const right = start.x + start.w;
    const maxW = right - Math.min(0, start.x);
    w = Math.max(min.w, Math.min(maxW, start.w - dx));
    x = right - w;
  }
  if (dir.includes("s")) h = Math.max(min.h, start.h + dy);
  if (dir.includes("n")) {
    const bottom = start.y + start.h;
    const maxH = bottom - Math.min(0, start.y);
    h = Math.max(min.h, Math.min(maxH, start.h - dy));
    y = bottom - h;
  }
  return { x, y, w, h };
}

const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

// Keyboard on the focused title bar: arrows move (10px, Shift 50px); Alt+arrows resize from the bottom-right corner
// (Right/Down grow, Left/Up shrink). Returns null for any other key.
export function keyboardStep(key, { shiftKey = false, altKey = false } = {}) {
  const d = ARROWS[key];
  if (!d) return null;
  const step = shiftKey ? KEY_STEP_BIG : KEY_STEP;
  return { kind: altKey ? "resize" : "move", dx: d[0] * step, dy: d[1] * step };
}

// Where a dialog opens: an explicit x/y wins, else centred ('center') or against the right edge ('right').
export function initialPosition({ vp, w, h, x = null, y = null, placement = "center" }) {
  const fitW = Math.min(w, Math.max(0, vp.w - 2 * MARGIN));
  const fitH = h == null ? 0 : h;
  return {
    x: x != null ? x : placement === "right" ? Math.max(0, vp.w - fitW - MARGIN) : Math.max(0, Math.round((vp.w - fitW) / 2)),
    y: y != null ? y : placement === "right" ? MARGIN : Math.max(0, Math.round((vp.h - fitH) / 2) - 30),
  };
}
