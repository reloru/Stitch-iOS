import { clamp } from './geometry';
import type { Rect } from './doc';

export interface Edges {
  l: boolean;
  r: boolean;
  t: boolean;
  b: boolean;
}

/**
 * Axis-aligned crop box drag inside a W×H image. No edges = move the box. With `aspect` (w/h) the box keeps
 * its ratio, anchored at the edges opposite the ones being dragged, and shrinks rather than leaving the image.
 */
export function dragRect(r0: Rect, e: Edges, dx: number, dy: number, W: number, H: number, aspect: number | null, minS: number): Rect {
  if (!e.l && !e.r && !e.t && !e.b) return { ...r0, x: clamp(r0.x + dx, 0, W - r0.w), y: clamp(r0.y + dy, 0, H - r0.h) };
  let L = r0.x;
  let R = r0.x + r0.w;
  let T = r0.y;
  let B = r0.y + r0.h;
  if (e.l) L = clamp(L + dx, 0, R - minS);
  if (e.r) R = clamp(R + dx, L + minS, W);
  if (e.t) T = clamp(T + dy, 0, B - minS);
  if (e.b) B = clamp(B + dy, T + minS, H);
  if (aspect) {
    let w = R - L;
    let h = B - T;
    const horiz = e.l || e.r;
    const vert = e.t || e.b;
    if (horiz && vert) {
      if (w / aspect > h) h = w / aspect;
      else w = h * aspect;
    } else if (horiz) h = w / aspect;
    else w = h * aspect;
    const cx = (L + R) / 2;
    const cy = (T + B) / 2;
    const maxW = e.l ? R : e.r ? W - L : 2 * Math.min(cx, W - cx);
    const maxH = e.t ? B : e.b ? H - T : 2 * Math.min(cy, H - cy);
    const s = Math.min(1, maxW / w, maxH / h);
    w *= s;
    h *= s;
    if (e.l) L = R - w;
    else if (e.r) R = L + w;
    else (L = cx - w / 2), (R = cx + w / 2);
    if (e.t) T = B - h;
    else if (e.b) B = T + h;
    else (T = cy - h / 2), (B = cy + h / 2);
  }
  return { x: L, y: T, w: R - L, h: B - T };
}

/** Largest box with the given aspect inside W×H, centred on (cx, cy) as far as the edges allow. */
export function aspectRect(aspect: number, W: number, H: number, cx = W / 2, cy = H / 2): Rect {
  let w = W;
  let h = W / aspect;
  if (h > H) {
    h = H;
    w = H * aspect;
  }
  return { x: clamp(cx - w / 2, 0, W - w), y: clamp(cy - h / 2, 0, H - h), w, h };
}
