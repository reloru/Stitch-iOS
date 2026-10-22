import { createCanvas, ctx2d } from './canvas';
import { uid } from './source';

/** Longest side of a mask bitmap. Masks are scaled up when composited, so soft edges are unaffected. */
export const MASK_MAX = 2048;

let versionCounter = 1;
export const nextVersion = () => ++versionCounter;

/**
 * A layer mask: alpha 1 = visible, 0 = hidden. Stored in the alpha channel of a canvas whose pixel grid maps
 * linearly onto the layer's source image (mask px = source px * scale). Mutable; `version` changes on every edit.
 */
export interface Mask {
  id: string;
  canvas: HTMLCanvasElement;
  /** mask px per source px */
  scale: number;
  version: number;
}

export function createMask(srcW: number, srcH: number): Mask {
  const scale = Math.min(1, MASK_MAX / Math.max(srcW, srcH));
  const canvas = createCanvas(srcW * scale, srcH * scale);
  const ctx = ctx2d(canvas);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return { id: uid('mask'), canvas, scale, version: nextVersion() };
}

export function cloneMask(m: Mask): Mask {
  const canvas = createCanvas(m.canvas.width, m.canvas.height);
  ctx2d(canvas).drawImage(m.canvas, 0, 0);
  return { id: uid('mask'), canvas, scale: m.scale, version: nextVersion() };
}

export function touch(m: Mask) {
  m.version = nextVersion();
}

export type BrushMode = 'hide' | 'reveal';

export interface Brush {
  /** radius in mask pixels */
  radius: number;
  /** 0..1: fraction of the radius that is fully opaque */
  hardness: number;
  /** 0..1 per-dab opacity */
  flow: number;
  mode: BrushMode;
}

export function dab(m: Mask, x: number, y: number, b: Brush) {
  const ctx = ctx2d(m.canvas);
  const r = Math.max(0.5, b.radius);
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  const hard = Math.max(0, Math.min(0.999, b.hardness));
  const col = b.mode === 'hide' ? '0,0,0' : '255,255,255';
  g.addColorStop(0, `rgba(${col},${b.flow})`);
  g.addColorStop(hard, `rgba(${col},${b.flow})`);
  g.addColorStop(1, `rgba(${col},0)`);
  ctx.save();
  ctx.globalCompositeOperation = b.mode === 'hide' ? 'destination-out' : 'source-over';
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** Dabs along a segment with spacing proportional to the radius; returns the leftover distance for the next segment. */
export function strokeSegment(m: Mask, x0: number, y0: number, x1: number, y1: number, b: Brush, carry: number): number {
  const spacing = Math.max(0.75, b.radius * 0.18);
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  let t = spacing - carry;
  while (t <= len) {
    dab(m, x0 + (dx * t) / len, y0 + (dy * t) / len, b);
    t += spacing;
  }
  return len - (t - spacing);
}

/** Multiplies the mask by a linear ramp: fully kept at (x0,y0), fully hidden at (x1,y1). */
export function linearGradient(m: Mask, x0: number, y0: number, x1: number, y1: number) {
  const ctx = ctx2d(m.canvas);
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.save();
  ctx.globalCompositeOperation = 'destination-in';
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, m.canvas.width, m.canvas.height);
  ctx.restore();
}

/** Multiplies the mask by a radial falloff: kept inside `r * (1 - feather)`, hidden beyond `r` (or the reverse). */
export function radialGradient(m: Mask, cx: number, cy: number, r: number, feather: number, invert: boolean) {
  const ctx = ctx2d(m.canvas);
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(1, r));
  const inner = Math.max(0, Math.min(0.999, 1 - feather));
  const a = invert ? 0 : 1;
  const b = invert ? 1 : 0;
  g.addColorStop(0, `rgba(255,255,255,${a})`);
  g.addColorStop(inner, `rgba(255,255,255,${a})`);
  g.addColorStop(1, `rgba(255,255,255,${b})`);
  ctx.save();
  ctx.globalCompositeOperation = 'destination-in';
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, m.canvas.width, m.canvas.height);
  ctx.restore();
}

export function fillMask(m: Mask, visible: boolean) {
  const ctx = ctx2d(m.canvas);
  ctx.save();
  ctx.globalCompositeOperation = 'copy';
  ctx.fillStyle = visible ? '#fff' : 'rgba(0,0,0,0)';
  ctx.fillRect(0, 0, m.canvas.width, m.canvas.height);
  ctx.restore();
}

export function invertMask(m: Mask) {
  const { width: w, height: h } = m.canvas;
  const ctx = ctx2d(m.canvas, { willReadFrequently: true });
  const id = ctx.getImageData(0, 0, w, h);
  const d = id.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = d[i + 1] = d[i + 2] = 255;
    d[i + 3] = 255 - d[i + 3];
  }
  ctx.putImageData(id, 0, 0);
}

export function readAlpha(m: Mask): Uint8Array {
  const { width: w, height: h } = m.canvas;
  const d = ctx2d(m.canvas).getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h);
  for (let i = 0, j = 3; i < out.length; i++, j += 4) out[i] = d[j];
  return out;
}

export function writeAlpha(m: Mask, alpha: Uint8Array) {
  const { width: w, height: h } = m.canvas;
  const ctx = ctx2d(m.canvas);
  const id = ctx.createImageData(w, h);
  const d = id.data;
  for (let i = 0, j = 0; i < alpha.length; i++, j += 4) {
    d[j] = d[j + 1] = d[j + 2] = 255;
    d[j + 3] = alpha[i];
  }
  ctx.putImageData(id, 0, 0);
}

/**
 * Selection by colour similarity (magic wand). `rgba` is the layer image at mask resolution.
 * Returns per-pixel selection strength 0..255, with a soft edge band of `tolerance * 0.25`.
 */
export function colorSelect(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  sx: number,
  sy: number,
  tolerance: number,
  contiguous: boolean,
): Uint8Array {
  const sel = new Uint8Array(w * h);
  sx = Math.max(0, Math.min(w - 1, Math.round(sx)));
  sy = Math.max(0, Math.min(h - 1, Math.round(sy)));
  const si = (sy * w + sx) * 4;
  const r0 = rgba[si];
  const g0 = rgba[si + 1];
  const b0 = rgba[si + 2];
  const tol = Math.max(1, tolerance);
  const soft = tol * 0.25;
  const strength = (i: number): number => {
    const p = i * 4;
    if (rgba[p + 3] < 8) return 0;
    const dr = rgba[p] - r0;
    const dg = rgba[p + 1] - g0;
    const db = rgba[p + 2] - b0;
    const dist = Math.sqrt(0.3 * dr * dr + 0.59 * dg * dg + 0.11 * db * db);
    if (dist <= tol) return 255;
    if (dist >= tol + soft) return 0;
    return Math.round(255 * (1 - (dist - tol) / soft));
  };
  if (!contiguous) {
    for (let i = 0; i < sel.length; i++) sel[i] = strength(i);
    return sel;
  }
  const visited = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let sp = 0;
  stack[sp++] = sy * w + sx;
  visited[sy * w + sx] = 1;
  while (sp > 0) {
    const i = stack[--sp];
    const s = strength(i);
    if (s === 0) continue;
    sel[i] = s;
    if (s < 255) continue; // soft edge pixels are included but do not spread the fill
    const x = i % w;
    const y = (i - x) / w;
    if (x > 0 && !visited[i - 1]) (visited[i - 1] = 1), (stack[sp++] = i - 1);
    if (x < w - 1 && !visited[i + 1]) (visited[i + 1] = 1), (stack[sp++] = i + 1);
    if (y > 0 && !visited[i - w]) (visited[i - w] = 1), (stack[sp++] = i - w);
    if (y < h - 1 && !visited[i + w]) (visited[i + w] = 1), (stack[sp++] = i + w);
  }
  return sel;
}

/** 3×3 box blur on a selection to anti-alias its edge. */
export function softenSelection(sel: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(sel.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          s += sel[yy * w + xx];
          n++;
        }
      }
      out[y * w + x] = Math.round(s / n);
    }
  }
  return out;
}

/** Combines a selection into a mask's alpha. 'hide' removes the selection, 'keep' hides everything else. */
export function applySelection(alpha: Uint8Array, sel: Uint8Array, mode: 'hide' | 'keep'): Uint8Array {
  const out = new Uint8Array(alpha.length);
  for (let i = 0; i < alpha.length; i++) {
    const s = sel[i] / 255;
    out[i] = Math.round(mode === 'hide' ? alpha[i] * (1 - s) : alpha[i] * s);
  }
  return out;
}
